import { describe, expect, it } from "bun:test";

import { applyTextToImageHeuristicToEnvelope } from "./text-to-image-heuristic";

describe("applyTextToImageHeuristicToEnvelope", () => {
  it("marks 画一只小猫 as text-to-image", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: "画一只小猫",
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBe(true);
  });

  it("marks 帮我画 as text-to-image", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: "帮我画一只猫",
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBe(true);
  });

  it("marks English first-line image prompts", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: "generate an image of a sunset",
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBe(true);
  });

  it("does not override when textToImage already true", () => {
    const base = {
      content: "anything",
      metadata: { modality: "text" as const, textToImage: true as const },
    };
    const out = applyTextToImageHeuristicToEnvelope(base);
    expect(out).toBe(base);
  });

  it("skips when vision / multimodal read is needed", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: [
        { type: "text" as const, text: "画一只小猫" },
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,xx" } },
      ],
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBeUndefined();
  });

  it("does not mark 画流程图 as text-to-image", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: "画流程图",
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBeUndefined();
  });

  it("does not mark 画面调度 as text-to-image", () => {
    const out = applyTextToImageHeuristicToEnvelope({
      content: "画面调度优化",
      metadata: { modality: "text" },
    });
    expect(out.metadata?.textToImage).toBeUndefined();
  });
});
