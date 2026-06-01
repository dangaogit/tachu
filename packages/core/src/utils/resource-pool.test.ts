import { describe, expect, test } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { Message } from "../types/message";
import type { MultimodalResolver, ResourceResolveEntry } from "../types/multimodal-resolver";
import {
  assembleResources,
  materializeMessages,
  refToken,
  renderTokensToDisplay,
  tokenKeysInContent,
} from "./resource-pool";

describe("assembleResources ( D2)", () => {
 test("string content passes through with no resources", () => {
    const r = assembleResources("hello");
    expect(r.content).toBe("hello");
    expect(r.resources).toHaveLength(0);
  });

 test("extracts image part into pool and appends a tail token", () => {
    const r = assembleResources([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
    ]);
    expect(r.resources).toHaveLength(1);
    const ref = r.resources[0]!;
    expect(ref.kind).toBe("image");
    expect(ref.displayLabel).toBe("[Image #1]");
    expect(r.content).toBe(`describe\n${refToken(ref)}`);
  });

 test("numbers resources per-kind in order", () => {
    const r = assembleResources([
      { type: "image_url", image_url: { url: "a" } },
      { type: "image_url", image_url: { url: "b" } },
      { type: "file", file: { mimeType: "application/pdf", uri: "doc" } },
    ]);
    expect(r.resources.map((x) => x.displayLabel)).toEqual([
      "[Image #1]",
      "[Image #2]",
      "[File #1]",
    ]);
  });

 test("inlines file.data as a data: uri", () => {
    const r = assembleResources([
      { type: "file", file: { mimeType: "image/png", data: "QQ==" } },
    ]);
    expect(r.resources[0]!.uri).toBe("data:image/png;base64,QQ==");
    expect(r.resources[0]!.kind).toBe("image");
  });
});

describe("token rendering ( D3)", () => {
 test("renderTokensToDisplay maps valid token to displayLabel", () => {
    const { content, resources } = assembleResources([
      { type: "text", text: "see" },
      { type: "image_url", image_url: { url: "x" } },
    ]);
    expect(renderTokensToDisplay(content, resources)).toBe("see\n[Image #1]");
  });

 test("forged token with no matching key is left as plain text (anti-injection)", () => {
    const forged = "look [[ref:image:00000000-0000-4000-8000-000000000000]]";
    expect(renderTokensToDisplay(forged, [])).toBe(forged);
  });

 test("tokenKeysInContent dedups and ignores malformed tokens", () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const content = `a [[ref:image:${key}]] b [[ref:image:${key}]] c [[ref:bad]]`;
    expect(tokenKeysInContent(content)).toEqual([key]);
  });
});

describe("materializeMessages ( D4/D5/D6)", () => {
  const key = "22222222-2222-4222-8222-222222222222";
  const message = (uri: string): Message => ({
    role: "user",
    content: `q [[ref:image:${key}]]`,
    resources: [{ key, kind: "image", uri, displayLabel: "[Image #1]" }],
  });

 test("only materializes refs whose token appears in the body (token ∩ pool)", async () => {
    const orphanKey = "33333333-3333-4333-8333-333333333333";
    const msg: Message = {
      role: "user",
      content: "no tokens here",
      resources: [{ key: orphanKey, kind: "image", uri: "data:image/png;base64,QQ==", displayLabel: "[Image #1]" }],
    };
    const { messages } = await materializeMessages([msg], undefined, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(messages[0]!.content).toBe("no tokens here");
  });

 test("inline image carrier requires no resolver; token kept in body, carrier in tail", async () => {
    const { messages } = await materializeMessages(
      [message("data:image/png;base64,QQ==")],
      undefined,
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const parts = messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(parts[0]!.text).toContain(`[[ref:image:${key}]]`);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

 test("opaque ref without resolver fails fast (D6c)", async () => {
    await expect(
      materializeMessages([message("opaque-id")], undefined, DEFAULT_ADAPTER_CALL_CONTEXT),
    ).rejects.toThrow();
  });

 test("runtime resolve failure degrades that resource (D6a)", async () => {
    const resolver: MultimodalResolver = {
      async resolveResources(refs) {
        const out = new Map<string, ResourceResolveEntry>();
        for (const r of refs) out.set(r.key, { ok: false, reason: "gone", userVisibleReason: "x" });
        return out;
      },
    };
    const { messages, degradations } = await materializeMessages(
      [message("opaque-id")],
      resolver,
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const parts = messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.text?.includes("[unavailable"))).toBe(true);
    expect(degradations).toHaveLength(1);
  });

 test("capability mismatch degrades without resolver call (D6a)", async () => {
    let called = false;
    const resolver: MultimodalResolver = {
      async resolveResources() {
        called = true;
        return new Map();
      },
    };
    const { degradations } = await materializeMessages(
      [message("opaque-id")],
      resolver,
      DEFAULT_ADAPTER_CALL_CONTEXT,
      { supportedKinds: new Set(["text"]) },
    );
    expect(called).toBe(false);
    expect(degradations[0]!.kind).toBe("image");
  });

 test("demand keys subset excludes non-demanded refs", async () => {
    const { messages } = await materializeMessages(
      [message("data:image/png;base64,QQ==")],
      undefined,
      DEFAULT_ADAPTER_CALL_CONTEXT,
      { demand: { mode: "keys", keys: new Set(["other"]) } },
    );
    expect(messages[0]!.content).toBe(`q [[ref:image:${key}]]`);
  });
});
