/**
 * 解析 `/draw …`、`/text-to-image …`、`/text2image …`（文生图）。
 *
 * 除了提示词，允许附加 `--save <path>` 或 `--save=<path>` 指定落盘位置；
 * 若 `<path>` 含空格，支持双引号 / 单引号包裹（例如：`--save "/tmp/cat with space.png"`）。
 *
 * 语义：
 *   - 命令名后须为空白或行尾，避免误匹配 `/drawing`。
 *   - 提示词可空，由调用方填默认中文提示。
 *   - `--save` 允许出现在 prompt 任何位置；解析时会从原文中剔除，只保留图像描述。
 *   - 若未提供 `--save`，继续尝试从 prompt **尾部自然语言**中抽取
 *     "保存到 /tmp/cat.png" / "save to ~/Desktop/output.jpg" 等启发式短语
 *     （见 {@link extractSavePathHeuristic}）。
 */
const RE = /^\/(?:draw|text-to-image|text2image)(?:\s+|$)/i;

/** CLI / chat 在仅触发文生图且无用户文案时使用的默认提示词。 */
export const DEFAULT_TEXT_TO_IMAGE_PROMPT = "画一幅细节丰富、构图合理的插画。";

/**
 * 解析结果。
 *
 * - `prompt`：真正送给 Provider 的文生图描述（已剔除 save 参数 / 启发式短语）；
 *   可能为空字符串，调用方负责兜底为 {@link DEFAULT_TEXT_TO_IMAGE_PROMPT}
 * - `savePath`：若命中 `--save <path>` 或"保存到 <path>"启发式，返回原始路径字符串
 */
export interface TextToImageSlashResult {
  prompt: string;
  savePath?: string;
}

export function tryParseTextToImageSlashCommand(
  line: string,
): TextToImageSlashResult | null {
  const t = line.trim();
  if (!RE.test(t)) {
    return null;
  }
  const rest = t.replace(/^\/(?:draw|text-to-image|text2image)/i, "").trim();
  const afterFlag = extractSaveFlag(rest);
  if (afterFlag.savePath !== undefined) {
    return afterFlag.savePath.length > 0
      ? { prompt: afterFlag.remaining.trim(), savePath: afterFlag.savePath }
      : { prompt: afterFlag.remaining.trim() };
  }
  const heuristic = extractSavePathHeuristic(rest);
  if (heuristic.savePath) {
    return { prompt: heuristic.prompt, savePath: heuristic.savePath };
  }
  return { prompt: rest };
}

/**
 * 解析 `--save <path>` / `--save=<path>`；允许 `<path>` 为带引号的字符串。
 *
 * 返回：
 *   - `savePath`：命中则为 path（可能为空字符串表示解析失败 / 没有值）
 *   - `remaining`：剔除掉 `--save …` 后的剩余 prompt
 */
const extractSaveFlag = (
  raw: string,
): { savePath?: string; remaining: string } => {
  const eqMatch = /(^|\s)--save=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(raw);
  if (eqMatch) {
    const p = eqMatch[2] ?? eqMatch[3] ?? eqMatch[4] ?? "";
    const remaining = (raw.slice(0, eqMatch.index) + raw.slice(eqMatch.index + eqMatch[0].length)).replace(/\s{2,}/g, " ");
    return { savePath: p, remaining };
  }
  const spaceMatch = /(^|\s)--save(?:\s+(?:"([^"]*)"|'([^']*)'|(\S+)))?/.exec(raw);
  if (spaceMatch) {
    const p = spaceMatch[2] ?? spaceMatch[3] ?? spaceMatch[4] ?? "";
    const remaining = (raw.slice(0, spaceMatch.index) + raw.slice(spaceMatch.index + spaceMatch[0].length)).replace(/\s{2,}/g, " ");
    return { savePath: p, remaining };
  }
  return { remaining: raw };
};

/**
 * 自然语言启发式：从 prompt 尾部抽取 "保存到 <path>"、"保存为 <path>"、
 * "save to <path>"、"save as <path>" 等短语。
 *
 * 匹配规则：
 *   - 仅从尾部识别，避免对中段描述文本造成误伤
 *   - path 必须形似文件路径（含 `/`、`\`、`~`、`C:` 之类）
 *   - 末尾若带中文句号 / 英文句号 / 逗号会被剔除
 *
 * 命中后返回剥离 save 短语的 prompt 与原 path。未命中返回 `{ prompt: raw, savePath: undefined }`。
 */
export const extractSavePathHeuristic = (
  raw: string,
): { prompt: string; savePath?: string } => {
  if (raw.trim().length === 0) {
    return { prompt: raw };
  }
  const pattern =
    /(^|[\s，,;；。、])(保存到|保存为|存到|存为|写入|写到|save\s+(?:to|as)|output\s+to)\s+["']?([^\s"'，,、]+)["']?[。.,，、]*\s*$/i;
  const m = pattern.exec(raw);
  if (!m || !m[3]) return { prompt: raw };
  const savePathRaw = m[3].trim();
  const savePath = savePathRaw.replace(/[。，、,]+$/, "").trim();
  if (!looksLikeFilePath(savePath)) return { prompt: raw };
  // m.index 指向前置 `m[1]`（空白 / 标点 / 空串）的位置；prompt 取其左侧并剥尾标点。
  const cut = m.index + (m[1]?.length ?? 0);
  const prompt = raw.slice(0, cut).replace(/[\s，,;；。、]+$/, "").trim();
  return { prompt, savePath };
};

const looksLikeFilePath = (s: string): boolean => {
  if (s.length === 0) return false;
  if (s.startsWith("/") || s.startsWith("~")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.startsWith("./") || s.startsWith("../")) return true;
  return /[\\/]/.test(s);
};

/**
 * 常见位图 / 矢量 / 现代图像容器扩展名。用于"隐式文生图意图识别"：
 * 当用户的 prompt 尾部出现"保存到 X.png"且扩展名属于本集合，即便 prompt 本体
 * 未出现"图 / image"等名词，也视为文生图请求（用户不可能把笔记 / 脚本存到 .png）。
 */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
  ".ico",
]);

const hasImageExtension = (filePath: string): boolean => {
  const m = /\.[a-z0-9]+$/i.exec(filePath);
  if (!m) return false;
  return IMAGE_EXTENSIONS.has(m[0].toLowerCase());
};

/**
 * 中文"动词 + ≤30 字 + 图像名词"的启发式强信号。
 *
 * 动词：生成 / 画 / 画出 / 绘制 / 制作 / 创作 / 创建 / 来一(张|幅|个) / 帮我画 / 帮我生成 / 帮我做
 * 名词：图 / 图片 / 图像 / 插画 / 海报 / 壁纸 / 头像 / 照片 / 封面 / logo / icon / avatar
 *
 * 典型命中：
 *   "生成一张橘猫图片"
 *   "画一幅水彩风景的插画"
 *   "帮我做一个游戏封面"
 */
const CN_VERB_NOUN_RE =
  /(?:生成|画出|绘制|制作|创作|创建|画|来一[张幅个]|帮我画|帮我生成|帮我做)[^\n]{0,30}?(?:图片|图像|图画|插画|海报|壁纸|头像|照片|封面|缩略图|示意图|流程图|架构图|logo|icon|avatar)/i;

/**
 * 英文 verb-phrase + image-noun 启发式。
 *
 * 典型命中：
 *   "draw a cat picture"
 *   "generate an illustration of..."
 *   "create a poster for..."
 */
const EN_VERB_NOUN_RE =
  /\b(?:draw|generate|create|paint|illustrate|render|make|produce|design)\b[^\n]{0,30}?\b(?:image|picture|photo|photograph|illustration|poster|wallpaper|avatar|drawing|painting|artwork|icon|logo|render|thumbnail)\b/i;

/**
 * {@link detectTextToImageIntent} 的命中来源。
 *
 * - `slash`：显式 `/draw` / `/text-to-image` / `/text2image`
 * - `heuristic-path`：尾部存在图像扩展名的保存路径（强信号，独立成立）
 * - `heuristic-keyword`：命中中文 / 英文 verb-noun 模式
 */
export type TextToImageIntentSource =
  | "slash"
  | "heuristic-path"
  | "heuristic-keyword";

export interface TextToImageIntentResult extends TextToImageSlashResult {
  source: TextToImageIntentSource;
}

/**
 * 综合识别一条 chat 输入是否是**文生图**请求。
 *
 * 识别优先级（命中即返）：
 *   1. **显式斜杠命令**：`/draw ...` / `/text-to-image ...` / `/text2image ...`
 *      → 完全委托 {@link tryParseTextToImageSlashCommand}
 *   2. **图像扩展名保存路径**（强信号）：尾部出现"保存到 /tmp/cat.png"且扩展名属于
 *      IMAGE_EXTENSIONS；即便 prompt 没有"图/image"等名词也视为文生图
 *   3. **关键词组合**：动词"生成/画/draw/generate/..." + 名词"图/image/..."同句出现
 *
 * 未命中返回 `null`，调用方回落到普通 chat。该函数只做本地正则，零成本，不调用 LLM。
 *
 * **有意不识别**：
 *   - 仅动词"生成一段文字 / 画出架构"之类无"图像扩展名 + 图像名词"的纯文本需求
 *   - 仅「保存到 X.txt / X.md / X.sh」非图像扩展名（走普通 chat）
 */
export function detectTextToImageIntent(
  line: string,
): TextToImageIntentResult | null {
  const slash = tryParseTextToImageSlashCommand(line);
  if (slash) {
    return slash.savePath !== undefined
      ? { prompt: slash.prompt, savePath: slash.savePath, source: "slash" }
      : { prompt: slash.prompt, source: "slash" };
  }
  const raw = line.trim();
  if (raw.length === 0) return null;

  const h = extractSavePathHeuristic(raw);
  if (h.savePath && hasImageExtension(h.savePath)) {
    return {
      prompt: h.prompt.length > 0 ? h.prompt : raw,
      savePath: h.savePath,
      source: "heuristic-path",
    };
  }

  if (CN_VERB_NOUN_RE.test(raw) || EN_VERB_NOUN_RE.test(raw)) {
    if (h.savePath) {
      return { prompt: h.prompt || raw, savePath: h.savePath, source: "heuristic-keyword" };
    }
    return { prompt: raw, source: "heuristic-keyword" };
  }

  return null;
}
