import type { InputEnvelope } from "../types/io";
import { envelopeNeedsVision } from "./input-vision";

/**
 * 从信封正文抽出用于匹配的纯文本（单行优先）。
 */
const flattenTextForHeuristic = (input: InputEnvelope): string => {
  const raw = input.content;
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
          return typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  try {
    return JSON.stringify(raw).trim();
  } catch {
    return String(raw).trim();
  }
};

/**
 * 常见「文生图」口语（中英），用于 **Intent LLM 不可用**时的兜底。
 * 正常路径由 Intent LLM 的 JSON 字段 `textToImage` 判定；此处保守避免「画流程图」等误判。
 */
const TEXT_TO_IMAGE_LINE = new RegExp(
  [
    "^(", // 行首
    "画[一二三四五六七八九十两\\d]*[只个幅张条头匹]", // 画一只、画个、画幅
    "|画点[儿]?什么", // 画点儿什么
    "|帮我画|给我画|替我画",
    "|生成[一二三四五六七八九十两\\d]*[幅张]图",
    "|来[一二三四五六七八九十两\\d]*[幅张]图",
    "|文生图|出[一二三四五六七八九十两\\d]*[幅张]图",
    "|^(draw|paint|generate|create)\\s+(a|an|the|\\d+)?\\s*(a\\s+)?(picture|image|photo|illustration)\\b",
    "|^make\\s+(a|an|the|\\d+)?\\s*(a\\s+)?(picture|image|photo)\\b",
    ")",
  ].join(""),
  "iu",
);

/**
 * 若正文像文生图请求且当前非读图多模态、未显式标记 textToImage，则打上 `metadata.textToImage=true`，
 * 路由与 `capabilityMapping["text-to-image"]` 一致（显式 CLI 另设 `explicitTextToImage` 并跳过 Intent LLM）。
 */
export function applyTextToImageHeuristicToEnvelope(input: InputEnvelope): InputEnvelope {
  if (input.metadata?.textToImage === true || envelopeNeedsVision(input)) {
    return input;
  }
  const text = flattenTextForHeuristic(input);
  if (text.length === 0 || text.length > 800) {
    return input;
  }
  const firstLine = text.split(/\r?\n/)[0] ?? text;
  if (!TEXT_TO_IMAGE_LINE.test(firstLine.trim())) {
    return input;
  }
  return {
    ...input,
    metadata: {
      ...input.metadata,
      modality: input.metadata?.modality ?? "text",
      textToImage: true,
    },
  };
}
