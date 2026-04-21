import { describe, expect, it } from "bun:test";
import { AnthropicProviderAdapter } from "../../src/providers/anthropic";

const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe("AnthropicProviderAdapter integration", () => {
  const run = hasAnthropicKey ? it : it.skip;

  run("calls real Anthropic API", async () => {
    const provider = new AnthropicProviderAdapter();
    const response = await provider.chat({
      model: "claude-3-5-haiku-latest",
      messages: [{ role: "user", content: "Reply with: ok" }],
      maxTokens: 32,
    });
    expect(response.content.toLowerCase()).toContain("ok");
  });
});
