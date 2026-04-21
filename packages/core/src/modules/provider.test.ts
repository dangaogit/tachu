import { describe, expect, test } from "bun:test";
import { ProviderError } from "../errors";
import { NoopProvider } from "./provider";

describe("NoopProvider", () => {
  test("supports list/chat/chatStream/countTokens", async () => {
    const provider = new NoopProvider();
    const models = await provider.listAvailableModels();
    expect(models).toHaveLength(3);

    const response = await provider.chat({
      model: "dev-small",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.content).toContain("[noop]");

    const chunks: string[] = [];
    let finished = false;
    for await (const chunk of provider.chatStream({
      model: "dev-small",
      messages: [{ role: "user", content: "stream me" }],
    })) {
      if (chunk.type === "text-delta") {
        chunks.push(chunk.delta);
      } else if (chunk.type === "finish") {
        finished = true;
        expect(chunk.finishReason).toBe("stop");
      }
    }
    expect(chunks.join("")).toContain("[noop]stream me");
    expect(finished).toBe(true);

    const count = await provider.countTokens?.(
      [{ role: "user", content: "abc" }, { role: "assistant", content: "de" }],
      "dev-small",
    );
    expect(count).toBe(5);
  });

  test("throws provider error when aborted", async () => {
    const provider = new NoopProvider();
    const controller = new AbortController();
    controller.abort("manual-stop");
    await expect(
      provider.chat(
        {
          model: "dev-small",
          messages: [{ role: "user", content: "hello" }],
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

