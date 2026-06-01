import { describe, expect, test } from "bun:test";
import type { ChatStreamChunk, ProviderAdapter } from "../modules/provider";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { Message, MessageContentPart } from "../types/message";
import type { MultimodalResolver, ResourceResolveEntry } from "../types/multimodal-resolver";
import type { ResourceReference } from "../types/resource";
import {
  chatWithResolvedMessages,
  streamChatWithResolvedMessages,
  resolveProviderDemand,
} from "./resolve-provider-messages";

const KEY = "11111111-1111-4111-8111-111111111111";

const stubAdapter = (
  onMessages: (m: Message[]) => void,
  modalities: string[] = ["text", "image"],
): ProviderAdapter => ({
  id: "stub",
  name: "stub",
  async listAvailableModels() {
    return [
      {
        modelName: "m",
        capabilities: {
          supportedModalities: modalities,
          maxContextTokens: 1000,
          supportsStreaming: true,
          supportsFunctionCalling: true,
        },
      },
    ];
  },
  async chat(request) {
    onMessages(request.messages);
    return {
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  },
  async *chatStream(request) {
    onMessages(request.messages);
    const chunk: ChatStreamChunk = {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    yield chunk;
  },
});

const imageRef = (uri: string): ResourceReference => ({
  key: KEY,
  kind: "image",
  uri,
  displayLabel: "[Image #1]",
});

const tokenMessage = (uri: string): Message => ({
  role: "user",
  content: `look [[ref:image:${KEY}]]`,
  resources: [imageRef(uri)],
});

describe("materialization seam ()", () => {
 test("opaque image ref is materialized via resolver into a tail refs block", async () => {
    const resolved = new Map<string, ResourceResolveEntry>([
      [KEY, { ok: true, part: { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } } }],
    ]);
    let receivedRefs: readonly ResourceReference[] = [];
    const resolver: MultimodalResolver = {
      async resolveResources(refs) {
        receivedRefs = refs;
        return resolved;
      },
    };
    let seen: Message[] = [];
    const result = await chatWithResolvedMessages(
      stubAdapter((m) => (seen = m)),
      { model: "m", messages: [tokenMessage("file_1")] },
      DEFAULT_ADAPTER_CALL_CONTEXT,
      resolver,
    );
    expect(result.ok).toBe(true);
    expect(receivedRefs.map((r) => r.key)).toEqual([KEY]);
    const parts = seen[0]?.content as MessageContentPart[];
    expect(Array.isArray(parts)).toBe(true);
 // 正文 token 原位保留
    expect((parts[0] as { text: string }).text).toContain(`[[ref:image:${KEY}]]`);
 // 尾部 refs 块含 Provider Image Carrier
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

 test("inline data: image ref is carried directly without invoking resolver", async () => {
    let resolverCalled = false;
    const resolver: MultimodalResolver = {
      async resolveResources() {
        resolverCalled = true;
        return new Map();
      },
    };
    let seen: Message[] = [];
    await chatWithResolvedMessages(
      stubAdapter((m) => (seen = m)),
      { model: "m", messages: [tokenMessage("data:image/png;base64,QQ==")] },
      DEFAULT_ADAPTER_CALL_CONTEXT,
      resolver,
    );
    expect(resolverCalled).toBe(false);
    const parts = seen[0]?.content as MessageContentPart[];
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

 test("missing resolver with an opaque ref fails fast (D6c)", async () => {
    await expect(
      chatWithResolvedMessages(
        stubAdapter(() => {}),
        { model: "m", messages: [tokenMessage("file_1")] },
        DEFAULT_ADAPTER_CALL_CONTEXT,
        undefined,
      ),
    ).rejects.toThrow();
  });

 test("capability mismatch degrades the resource in-dialogue (D6a)", async () => {
    const resolver: MultimodalResolver = {
      async resolveResources() {
        return new Map();
      },
    };
    let seen: Message[] = [];
    await chatWithResolvedMessages(
      stubAdapter((m) => (seen = m), ["text"]),
      { model: "m", messages: [tokenMessage("file_1")] },
      DEFAULT_ADAPTER_CALL_CONTEXT,
      resolver,
    );
    const parts = seen[0]?.content as MessageContentPart[];
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
    expect(
      parts.some((p) => p.type === "text" && p.text.includes("[unavailable")),
    ).toBe(true);
  });

 test("streaming path materializes before chatStream", async () => {
    const resolver: MultimodalResolver = {
      async resolveResources() {
        return new Map<string, ResourceResolveEntry>([
          [KEY, { ok: true, part: { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } } }],
        ]);
      },
    };
    let seen: Message[] = [];
    for await (const _ of streamChatWithResolvedMessages(
      stubAdapter((m) => (seen = m)),
      { model: "m", messages: [tokenMessage("file_1")] },
      DEFAULT_ADAPTER_CALL_CONTEXT,
      resolver,
    )) {
 // drain
    }
    const parts = seen[0]?.content as MessageContentPart[];
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });
});

describe("resolveProviderDemand + degradation surfacing ()", () => {
 test("no router → returns undefined (seam defaults to full fidelity)", async () => {
    const demand = await resolveProviderDemand(undefined, {
      adapter: stubAdapter(() => {}),
      model: "m",
      unit: "direct-answer",
      phase: "direct-answer",
      messages: [tokenMessage("file_1")],
    });
    expect(demand).toBeUndefined();
  });

 test("router selector is expanded; demand restricts materialized subset", async () => {
    const KEY2 = "22222222-2222-4222-8222-222222222222";
    const msg: Message = {
      role: "user",
      content: `a [[ref:image:${KEY}]] b [[ref:image:${KEY2}]]`,
      resources: [
        { key: KEY, kind: "image", uri: "data:image/png;base64,QQ==", displayLabel: "[Image #1]" },
        { key: KEY2, kind: "image", uri: "data:image/png;base64,QQ==", displayLabel: "[Image #2]" },
      ],
    };
    let ctxSupported: ReadonlySet<string> | undefined;
    const demand = await resolveProviderDemand(
      (rctx) => {
        ctxSupported = rctx.supportedKinds;
        return { mode: "select", scope: "prompt", keys: new Set([KEY]) };
      },
      {
        adapter: stubAdapter(() => {}),
        model: "m",
        unit: "tool-use",
        phase: "tool-use",
        messages: [msg],
      },
    );
    expect(demand?.mode).toBe("keys");
    if (demand?.mode === "keys") {
      expect([...demand.keys]).toEqual([KEY]);
    }
 // router receives model capability context ( D4a / )
    expect(ctxSupported && [...ctxSupported].sort()).toEqual(["image", "text"]);
  });

 test("streaming surfaces degradations via onDegradations (D6b)", async () => {
    const resolver: MultimodalResolver = {
      async resolveResources() {
        return new Map();
      },
    };
    let surfaced: { required: boolean; kind: string }[] = [];
    for await (const _ of streamChatWithResolvedMessages(
      stubAdapter(() => {}, ["text"]), // model lacks image → capability degradation
      { model: "m", messages: [tokenMessage("file_1")] },
      DEFAULT_ADAPTER_CALL_CONTEXT,
      resolver,
      undefined,
      undefined,
      (degradations) => {
        surfaced = degradations.map((d) => ({ required: d.required, kind: d.kind }));
      },
    )) {
 // drain
    }
    expect(surfaced).toEqual([{ required: false, kind: "image" }]);
  });
});
