import { describe, expect, it } from "bun:test";
import type { ChatFinishReason, ToolCallRequest } from "@tachu/core";
import { MockProviderAdapter } from "../../src/providers/mock";

describe("MockProviderAdapter", () => {
  it("returns deterministic chat response", async () => {
    const provider = new MockProviderAdapter();
    const response = await provider.chat({
      model: "mock-chat",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.content).toBe("mock:hello");
    expect(response.finishReason).toBe("stop");
    expect(response.toolCalls).toBeUndefined();
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  it("streams response as text-delta chunks and ends with finish", async () => {
    const provider = new MockProviderAdapter();
    let output = "";
    let finished = false;
    let finishReason: ChatFinishReason | undefined;
    for await (const chunk of provider.chatStream({
      model: "mock-chat",
      messages: [{ role: "user", content: "abc" }],
    })) {
      if (chunk.type === "text-delta") {
        output += chunk.delta;
      } else if (chunk.type === "finish") {
        finished = true;
        finishReason = chunk.finishReason;
      }
    }
    expect(output.includes("mock:abc")).toBe(true);
    expect(finished).toBe(true);
    expect(finishReason).toBe("stop");
  });

  it("plays scripted replies in order, advancing through tool-use turns", async () => {
    const readFile: ToolCallRequest = {
      id: "call-1",
      name: "read-file",
      arguments: { path: "/tmp/a.txt" },
    };
    const fetchUrl: ToolCallRequest = {
      id: "call-2",
      name: "fetch-url",
      arguments: { url: "https://example.com" },
    };
    const provider = new MockProviderAdapter({
      replies: [
        { content: "", toolCalls: [readFile] },
        { content: "intermediate", toolCalls: [fetchUrl] },
        { content: "final answer", finishReason: "stop" },
      ],
    });

    const step1 = await provider.chat({
      model: "mock-chat",
      messages: [{ role: "user", content: "do a thing" }],
    });
    expect(step1.toolCalls).toEqual([readFile]);
    expect(step1.finishReason).toBe("tool_calls");

    const step2 = await provider.chat({
      model: "mock-chat",
      messages: [
        { role: "user", content: "do a thing" },
        { role: "assistant", content: "", toolCalls: [readFile] },
        { role: "tool", toolCallId: "call-1", content: "file body" },
      ],
    });
    expect(step2.content).toBe("intermediate");
    expect(step2.toolCalls).toEqual([fetchUrl]);

    const step3 = await provider.chat({
      model: "mock-chat",
      messages: [{ role: "user", content: "next" }],
    });
    expect(step3.content).toBe("final answer");
    expect(step3.finishReason).toBe("stop");
    expect(step3.toolCalls).toBeUndefined();

    const afterExhaustion = await provider.chat({
      model: "mock-chat",
      messages: [{ role: "user", content: "extra" }],
    });
    expect(afterExhaustion.content).toBe("mock:extra");
  });

  it("streams scripted tool-call replies as tool-call-delta + complete events", async () => {
    const call: ToolCallRequest = {
      id: "call-x",
      name: "list-dir",
      arguments: { path: "." },
    };
    const provider = new MockProviderAdapter({
      replies: [{ content: "", toolCalls: [call] }],
    });
    const events: string[] = [];
    let completedCall: ToolCallRequest | undefined;
    let finishReason: ChatFinishReason | undefined;
    for await (const chunk of provider.chatStream({
      model: "mock-chat",
      messages: [{ role: "user", content: "list current dir" }],
    })) {
      events.push(chunk.type);
      if (chunk.type === "tool-call-complete") {
        completedCall = chunk.call;
      } else if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
      }
    }
    expect(events).toEqual(["tool-call-delta", "tool-call-complete", "finish"]);
    expect(completedCall).toEqual(call);
    expect(finishReason).toBe("tool_calls");
  });
});
