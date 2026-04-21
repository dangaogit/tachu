import { describe, expect, it } from "bun:test";
import { OpenAIProviderAdapter } from "../../src/providers/openai";

const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);

describe("OpenAIProviderAdapter integration", () => {
  const run = hasOpenAiKey ? it : it.skip;

  run("calls real OpenAI API", async () => {
    const provider = new OpenAIProviderAdapter();
    const response = await provider.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Reply with: ok" }],
      maxTokens: 16,
    });
    expect(response.content.toLowerCase()).toContain("ok");
  });
});
