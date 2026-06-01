import { describe, expect, test } from "bun:test";
import { runSessionPhase } from "./session";
import type { ExecutionContext, InputEnvelope } from "../../types";
import type { MemoryEntry, MemorySystem } from "../../modules/memory";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";

describe("runSessionPhase", () => {
 test("assembles multimodal parts into a token body + side-channel resources before memory append ( D2)", async () => {
    const appended: MemoryEntry[] = [];
    const memory: MemorySystem = {
      async load() {
        return { entries: appended, tokenCount: 0, limit: 8000 };
      },
      async loadFull() {
        return appended;
      },
      async append(_sessionId, entry) {
        appended.push(entry);
      },
      async compress() {},
      async recall() {
        return [];
      },
      async archive() {},
      async getSize() {
        return { entries: appended.length, tokens: 0 };
      },
      async trim() {},
      async clear() {},
    };

    const parts = [
      { type: "text" as const, text: "compare" },
      { type: "file" as const, file: { mimeType: "image/png", uri: "opaque-1" } },
    ];
    const input: InputEnvelope = {
      content: parts,
      metadata: { modality: "image", size: 10 },
    };
    const context: ExecutionContext = {
      correlation: {
        sessionId: "sess-1",
        requestId: "req-1",
        traceId: "trace-1",
        turnId: "turn-1",
      },
      principal: { role: "tester", tenant: 1 },
      budget: {},
      scopes: ["*"],
    };

    await runSessionPhase(input, context, {
      sessionManager: {
        async resolve() {},
      },
      memorySystem: memory,
      runtimeState: {
        async update() {},
      },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    } as never);

    expect(appended).toHaveLength(1);
    const entry = appended[0];
    const content = entry?.content;
 // D2：本轮 user 在写入 memory 前被装配为「token 正文 + 旁路 resources」。
    expect(typeof content).toBe("string");
    expect(content as string).toContain("compare");
    expect(content as string).toMatch(/\[\[ref:image:[0-9a-f-]+\]\]/);

 // 图像不再以 base64/parts 形态留在正文，而是进入 Resource Pool。
    expect(entry?.resources).toBeDefined();
    expect(entry?.resources).toHaveLength(1);
    const ref = entry?.resources?.[0];
    expect(ref?.kind).toBe("image");
    expect(ref?.uri).toBe("opaque-1");
 // 正文里的 token 与 resource 的 key 必须呼应（纯文本可定位）。
    expect(content as string).toContain(ref?.key ?? "__missing__");
  });
});
