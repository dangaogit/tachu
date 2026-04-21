import { describe, expect, it } from "bun:test";
import { ValidationError } from "../errors";
import {
  buildMultimodalInputEnvelope,
  buildMultimodalUserContent,
  buildTextToImageInputEnvelope,
} from "./multimodal-envelope";

describe("multimodal-envelope", () => {
  it("text-only returns string", () => {
    expect(buildMultimodalUserContent({ text: "hi", images: [] })).toBe("hi");
  });

  it("single image without text returns parts array", () => {
    const c = buildMultimodalUserContent({
      text: "",
      images: [{ mimeType: "image/png", base64: "qqq" }],
    });
    expect(Array.isArray(c)).toBe(true);
    const parts = c as { type: string; image_url?: { url: string } }[];
    expect(parts[0]?.type).toBe("image_url");
    expect(parts[0]?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("text + image interleaves text first", () => {
    const c = buildMultimodalUserContent({
      text: "describe",
      images: [{ mimeType: "image/jpeg", base64: "abc" }],
    }) as { type: string }[];
    expect(c[0]?.type).toBe("text");
    expect(c[1]?.type).toBe("image_url");
  });

  it("rejects bad mime", () => {
    expect(() =>
      buildMultimodalUserContent({
        text: "x",
        images: [{ mimeType: "application/pdf", base64: "qq" }],
      }),
    ).toThrow(ValidationError);
  });

  it("buildTextToImageInputEnvelope sets textToImage metadata", () => {
    const env = buildTextToImageInputEnvelope("一只猫", "test");
    expect(env.content).toBe("一只猫");
    expect(env.metadata.textToImage).toBe(true);
    expect(env.metadata.explicitTextToImage).toBe(true);
    expect(env.metadata.modality).toBe("text");
  });

  it("buildMultimodalInputEnvelope sets modality image when images present", () => {
    const env = buildMultimodalInputEnvelope({
      text: "t",
      images: [{ mimeType: "image/png", base64: "q" }],
      source: "test",
    });
    expect(env.metadata.modality).toBe("image");
    expect(env.metadata.source).toBe("test");
  });
});
