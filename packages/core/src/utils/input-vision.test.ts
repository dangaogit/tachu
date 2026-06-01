import { describe, expect, test } from "bun:test";
import { envelopeNeedsVision, messagesNeedVision } from "./input-vision";
import type { InputEnvelope } from "../types/io";
import type { Message } from "../types/message";

describe("envelopeNeedsVision", () => {
 test("returns true for metadata.modality image", () => {
    const input: InputEnvelope = {
      content: "hello",
      metadata: { modality: "image", size: 5 },
    };
    expect(envelopeNeedsVision(input)).toBe(true);
  });

 test("returns true for image_url parts", () => {
    const input: InputEnvelope = {
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,ab" } }],
      metadata: { modality: "text", size: 1 },
    };
    expect(envelopeNeedsVision(input)).toBe(true);
  });

 test("returns true for file part with image MIME (B1 uri refs)", () => {
    const input: InputEnvelope = {
      content: [
        { type: "text", text: "describe" },
        { type: "file", file: { mimeType: "image/png", uri: "opaque-file-id-1" } },
      ],
      metadata: { modality: "image", size: 10 },
    };
    expect(envelopeNeedsVision(input)).toBe(true);
  });

 test("returns false for plain text", () => {
    const input: InputEnvelope = {
      content: "hello",
      metadata: { modality: "text", size: 5 },
    };
    expect(envelopeNeedsVision(input)).toBe(false);
  });
});

describe("messagesNeedVision", () => {
 test("returns true when user message has file image ref", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "file", file: { mimeType: "image/jpeg", uri: "ref-1" } }],
      },
    ];
    expect(messagesNeedVision(messages)).toBe(true);
  });
});
