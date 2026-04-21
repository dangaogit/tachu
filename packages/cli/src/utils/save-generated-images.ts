import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { GeneratedImage } from "@tachu/core";

/**
 * `tachu run --save-image <path>` / `/draw ... --save <path>` 的输入：
 *   - `cwd`：用于相对路径归一化
 *   - `images`：`EngineOutput.metadata.generatedImages`（可能为空）
 *   - `target`：用户传入的目标路径，可以是：
 *       1. 已存在目录 → 批量写入 `<target>/generated-<index>.<ext>`
 *       2. 非存在且以 `/` 结尾 → 视为目录，自动创建
 *       3. 其它 → 视为文件路径；多图时自动编号（`foo.png` / `foo-2.png` / ...）
 *
 * 写入行为：
 *   - `fetch()` 远端 URL / `data:` URL 解码 → `fs.writeFile`
 *   - 父目录不存在时自动 `mkdir -p`
 *   - 不做沙盒校验：CLI 主命令里显式传入的路径等价于用户授权（等价 `curl -o`）
 *   - 若单条图片下载失败，不中断其它图片（错误累计后统一上报）
 *
 * 返回每张图片的最终绝对路径与字节数；调用方据此渲染提示信息。
 */
export interface SaveGeneratedImagesOptions {
  cwd: string;
  images: GeneratedImage[];
  target: string;
  signal?: AbortSignal;
  /** 已存在的同名文件是否覆盖写入；默认 true。为 false 时自动追加 `-<n>` 后缀 */
  overwrite?: boolean;
}

export interface SavedImageRecord {
  /** 原始图片 URL（或 data URL 的前 32 字节预览） */
  source: string;
  /** 最终落盘的绝对路径 */
  path: string;
  /** 落盘字节数 */
  bytes: number;
  /** 若干下载失败：承载错误文本；成功时为 undefined */
  error?: string;
}

const DATA_URL_PREFIX = /^data:([^;,]+)(;base64)?,(.*)$/i;

/**
 * 从 GeneratedImage 推断扩展名，优先级：`mimeType` → URL 扩展名 → `.png` 兜底。
 */
const inferExtension = (image: GeneratedImage): string => {
  if (image.mimeType) {
    const m = image.mimeType.toLowerCase();
    if (m === "image/png") return ".png";
    if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
    if (m === "image/webp") return ".webp";
    if (m === "image/gif") return ".gif";
    if (m === "image/bmp") return ".bmp";
    if (m === "image/svg+xml") return ".svg";
  }
  if (!image.url.startsWith("data:")) {
    const clean = image.url.split(/[?#]/)[0] ?? "";
    const ext = extname(clean);
    if (ext && /^\.[a-z0-9]{2,5}$/i.test(ext)) {
      return ext.toLowerCase();
    }
  }
  return ".png";
};

const isDirectoryLikePath = (p: string): boolean => p.endsWith("/") || p.endsWith("\\");

const pathExistsAsDirectory = async (p: string): Promise<boolean> => {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const resolveTarget = (cwd: string, target: string): string =>
  isAbsolute(target) ? target : resolve(cwd, target);

const appendSuffixBeforeExt = (filePath: string, suffix: string): string => {
  const ext = extname(filePath);
  const base = ext.length > 0 ? filePath.slice(0, -ext.length) : filePath;
  return `${base}${suffix}${ext}`;
};

const uniqueName = async (
  filePath: string,
  existing: Set<string>,
): Promise<string> => {
  if (!existing.has(filePath) && !(await pathExists(filePath))) {
    existing.add(filePath);
    return filePath;
  }
  for (let i = 2; i < 10_000; i++) {
    const candidate = appendSuffixBeforeExt(filePath, `-${i}`);
    if (!existing.has(candidate) && !(await pathExists(candidate))) {
      existing.add(candidate);
      return candidate;
    }
  }
  throw new Error(`无法为 ${filePath} 生成唯一的文件名（尝试了 1 万次）`);
};

const fetchImageBytes = async (
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const m = DATA_URL_PREFIX.exec(url);
  if (m) {
    const isBase64 = !!m[2];
    const payload = m[3] ?? "";
    if (isBase64) {
      return Uint8Array.from(Buffer.from(payload, "base64"));
    }
    return Uint8Array.from(Buffer.from(decodeURIComponent(payload), "utf8"));
  }
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
};

const previewSource = (url: string): string => {
  if (url.startsWith("data:")) {
    return `${url.slice(0, Math.min(32, url.length))}…`;
  }
  return url;
};

/**
 * 执行下载 + 落盘；单张失败不影响其它。
 *
 * 返回记录顺序与 `images` 一致；失败条目的 `bytes` 为 0 并带 `error`。
 */
export const saveGeneratedImages = async (
  opts: SaveGeneratedImagesOptions,
): Promise<SavedImageRecord[]> => {
  if (opts.images.length === 0) return [];
  const targetRaw = opts.target.trim();
  if (targetRaw.length === 0) {
    throw new Error("--save-image 需要非空路径");
  }
  const target = resolveTarget(opts.cwd, targetRaw);
  const overwrite = opts.overwrite !== false;

  const looksLikeDir =
    isDirectoryLikePath(targetRaw) || (await pathExistsAsDirectory(target));

  const records: SavedImageRecord[] = [];
  const claimed = new Set<string>();

  if (looksLikeDir) {
    await mkdir(target, { recursive: true });
    for (let i = 0; i < opts.images.length; i++) {
      const image = opts.images[i]!;
      const ext = inferExtension(image);
      let filePath = resolve(target, `generated-${image.index + 1}${ext}`);
      if (!overwrite) {
        filePath = await uniqueName(filePath, claimed);
      } else {
        claimed.add(filePath);
      }
      records.push(await writeOne(image, filePath, opts.signal));
    }
    return records;
  }

  await mkdir(dirname(target), { recursive: true });
  if (opts.images.length === 1) {
    const image = opts.images[0]!;
    let filePath = target;
    if (!overwrite) {
      filePath = await uniqueName(target, claimed);
    }
    records.push(await writeOne(image, filePath, opts.signal));
    return records;
  }

  const baseExt = extname(target);
  const baseName = baseExt ? basename(target, baseExt) : basename(target);
  const dir = dirname(target);
  for (let i = 0; i < opts.images.length; i++) {
    const image = opts.images[i]!;
    const ext = baseExt || inferExtension(image);
    const name = i === 0 ? baseName : `${baseName}-${i + 1}`;
    let filePath = resolve(dir, `${name}${ext}`);
    if (!overwrite) {
      filePath = await uniqueName(filePath, claimed);
    } else {
      claimed.add(filePath);
    }
    records.push(await writeOne(image, filePath, opts.signal));
  }
  return records;
};

const writeOne = async (
  image: GeneratedImage,
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<SavedImageRecord> => {
  try {
    const bytes = await fetchImageBytes(image.url, signal);
    await writeFile(filePath, bytes);
    return { source: previewSource(image.url), path: filePath, bytes: bytes.byteLength };
  } catch (err) {
    return {
      source: previewSource(image.url),
      path: filePath,
      bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
