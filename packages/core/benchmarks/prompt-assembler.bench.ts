import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { ByteEstimateTokenizer, DefaultPromptAssembler, type AssembleParams } from "../src";

test("prompt assembler benchmark 4k window x100", async () => {
  const assembler = new DefaultPromptAssembler();
  const tokenizer = new ByteEstimateTokenizer();
  const context = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : ("assistant" as const),
    content: `history-${index} `.repeat(14),
    timestamp: Date.now() + index,
    anchored: false,
  }));

  const params: AssembleParams = {
    phase: "planning",
    model: "dev-large",
    tokenizer,
    modelCapabilities: {
      supportedModalities: ["text"],
      maxContextTokens: 8_192,
      supportsFunctionCalling: true,
      supportsStreaming: true,
    },
    currentInput: { content: "请输出执行计划", metadata: { modality: "text", size: 64 } },
    activeRules: [],
    activeSkills: [],
    availableTools: [],
    contextWindow: {
      entries: context,
      tokenCount: 4_000,
      limit: 8_000,
    },
    recalledEntries: [],
    reserveOutputTokens: 2_048,
  };

  const loops = 100;
  const started = performance.now();
  let lastTokenCount = 0;
  for (let i = 0; i < loops; i += 1) {
    const assembled = await assembler.assemble(params);
    lastTokenCount = assembled.tokenCount;
  }
  const elapsed = performance.now() - started;
  console.log(`prompt-assembler.bench: ${(elapsed / loops).toFixed(2)}ms avg`);
  expect(lastTokenCount).toBeGreaterThan(0);
});

