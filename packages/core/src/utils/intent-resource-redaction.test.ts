import { describe, expect, test } from "bun:test";
import type { Message } from "../types/message";
import { redactResourcesForIntent } from "./intent-resource-redaction";

describe("redactResourcesForIntent", () => {
 test("replaces an image file part with an [Image #1] token, preserving text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image" },
          { type: "file", file: { mimeType: "image/png", uri: "file-1" } },
        ],
      },
    ];

    const redacted = redactResourcesForIntent(messages);

    expect(redacted[0]?.content).toBe("what is in this image\n[Image #1]");
  });

 test("replaces inline image_url with [Image #1] and non-image file with [File #1]", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "and this doc" },
          { type: "file", file: { mimeType: "application/pdf", uri: "doc-1" } },
        ],
      },
    ];

    const redacted = redactResourcesForIntent(messages);

    expect(redacted[0]?.content).toBe("[Image #1]\nand this doc\n[File #1]");
  });

 test("passes string content through and never mutates the input messages", () => {
    const original: Message[] = [
      { role: "system", content: "you are a router" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,SECRET" } },
        ],
      },
    ];

    const redacted = redactResourcesForIntent(original);

    expect(redacted[0]?.content).toBe("you are a router");
 // input untouched: original still holds the base64 part
    expect(Array.isArray(original[1]?.content)).toBe(true);
    expect(JSON.stringify(original)).toContain("SECRET");
 // output carries no base64
    expect(JSON.stringify(redacted)).not.toContain("SECRET");
  });
});
