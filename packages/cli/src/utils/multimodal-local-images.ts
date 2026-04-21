import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { EngineConfig, InputEnvelope, MultimodalImagePartInput } from "@tachu/core";
import { ValidationError, buildMultimodalInputEnvelope } from "@tachu/core";
import { resolveAllowedPath } from "@tachu/extensions";
import { detectImageMimeFromMagic } from "./image-mime";

/**
 * 由 `safety.workspaceRoot` 与 `allowedWriteRoots` 构造读文件沙箱根列表（与 read-file 类同）。
 */
export function buildCliReadSandboxRoots(cwd: string, config: EngineConfig): string[] {
  const roots = new Set<string>();
  const addRoot = (p: string): void => {
    try {
      roots.add(realpathSync(p));
    } catch {
      /* 路径不存在则跳过 */
    }
  };
  try {
    addRoot(resolve(cwd, config.safety.workspaceRoot));
  } catch {
    addRoot(cwd);
  }
  if (roots.size === 0) {
    addRoot(cwd);
  }
  for (const raw of config.safety.allowedWriteRoots ?? []) {
    const p = isAbsolute(raw) ? raw : resolve(cwd, raw);
    addRoot(p);
  }
  return [...roots];
}

export interface LoadMultimodalFromLocalPathsOptions {
  cwd: string;
  config: EngineConfig;
  imagePaths: string[];
  /** 与图片一起发送的文字；若为空则用 `defaultText` */
  text: string;
  /** `text` 为空时的默认提示 */
  defaultText: string;
  /** observability / metadata.source */
  source: string;
}

/**
 * 读取本地图片（经沙箱路径校验 + 魔数 MIME），构造 {@link InputEnvelope}。
 */
export async function loadMultimodalEnvelopeFromLocalImages(
  options: LoadMultimodalFromLocalPathsOptions,
): Promise<InputEnvelope> {
  const { cwd, config, imagePaths, defaultText, source } = options;
  const text = options.text.trim().length > 0 ? options.text.trim() : defaultText;
  if (imagePaths.length === 0) {
    throw ValidationError.invalidConfig("至少需要一张图片路径", { imagePaths });
  }

  const allowedRoots = buildCliReadSandboxRoots(cwd, config);
  if (allowedRoots.length === 0) {
    throw ValidationError.invalidConfig("无法解析工作区根目录，请检查 safety.workspaceRoot", {});
  }

  const maxBytes = config.safety.maxInputSizeBytes;

  const images: MultimodalImagePartInput[] = [];
  for (const userPath of imagePaths) {
    const abs = resolveAllowedPath(userPath, { allowedRoots });
    const buf = await readFile(abs);
    if (buf.byteLength > maxBytes) {
      throw ValidationError.invalidResult(
        `图片过大：${userPath} → ${buf.byteLength} bytes（上限 safety.maxInputSizeBytes=${maxBytes}）`,
        { path: userPath, size: buf.byteLength, maxBytes },
      );
    }
    const mime = detectImageMimeFromMagic(buf);
    if (!mime) {
      throw ValidationError.invalidResult(
        `无法从文件头识别为支持的图片格式（PNG / JPEG / GIF / WebP）：${userPath}`,
        { path: userPath },
      );
    }
    images.push({
      mimeType: mime,
      base64: buf.toString("base64"),
    });
  }

  return buildMultimodalInputEnvelope({
    text,
    images,
    source,
  });
}

/**
 * 从 `process.argv` 收集重复出现的 `--image <path>`（支持多次指定）。
 */
export function collectRepeatedArgvFlag(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag) {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        out.push(v);
      }
    }
  }
  return out;
}
