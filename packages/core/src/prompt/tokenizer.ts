import { createRequire } from "node:module";
import { ByteEstimateTokenizer, type TokenizerLike } from "./tokenizer-fallback";

/**
 * Tokenizer 统一接口（同步）。
 */
export interface Tokenizer extends TokenizerLike {}

type TiktokenEncoding = {
  encode(text: string): number[];
  decode(tokens: number[]): Uint8Array;
  free?(): void;
};

type TiktokenModule = {
  encoding_for_model(model: string): TiktokenEncoding;
  get_encoding(name: string): TiktokenEncoding;
};

const requireFn = createRequire(import.meta.url);
let cachedModule: TiktokenModule | null | undefined;
let moduleLoadErrorReported = false;

const loadTiktokenModule = (
  onWarning?: (message: string) => void,
): TiktokenModule | null => {
  if (cachedModule !== undefined) {
    return cachedModule;
  }
  try {
    cachedModule = requireFn("tiktoken") as TiktokenModule;
  } catch (error) {
    cachedModule = null;
    if (!moduleLoadErrorReported) {
      moduleLoadErrorReported = true;
      onWarning?.(
        `tiktoken 加载失败，已降级字节估算: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return cachedModule;
};

const chooseFallbackEncoding = (model: string): string => {
  if (model.includes("gpt-4o") || model.includes("o1") || model.includes("o3")) {
    return "o200k_base";
  }
  if (model.includes("claude")) {
    return "cl100k_base";
  }
  return "cl100k_base";
};

/**
 * 基于 tiktoken 的精确 Tokenizer（同步）。
 *
 * 创建时绑定单个 model。若 `tiktoken` 模块在运行环境不可用或无法为该 model 创建 encoding，
 * 所有方法会同步降级到 `ByteEstimateTokenizer`，保持接口语义一致。
 */
export class TiktokenTokenizer implements Tokenizer {
  private readonly fallback = new ByteEstimateTokenizer();
  private encoding: TiktokenEncoding | null = null;
  private degraded = false;

  /**
   * @param model 需要绑定的 model 名（如 `gpt-4o-mini`、`claude-sonnet-4-20250514`）。
   * @param onWarning 降级告警回调。
   */
  constructor(
    private readonly model: string,
    private readonly onWarning?: (message: string) => void,
  ) {
    const mod = loadTiktokenModule(onWarning);
    if (!mod) {
      this.degraded = true;
      return;
    }
    try {
      this.encoding = mod.encoding_for_model(model);
    } catch {
      try {
        this.encoding = mod.get_encoding(chooseFallbackEncoding(model));
      } catch {
        this.warnOnce(`tiktoken 无法为模型 ${model} 创建编码，降级为字节估算`);
      }
    }
  }

  count(text: string): number {
    if (!this.encoding) {
      return this.fallback.count(text);
    }
    return this.encoding.encode(text).length;
  }

  encode(text: string): number[] {
    if (!this.encoding) {
      return this.fallback.encode(text);
    }
    return [...this.encoding.encode(text)];
  }

  decode(tokens: number[]): string {
    if (!this.encoding) {
      return this.fallback.decode(tokens);
    }
    const bytes = this.encoding.decode(tokens);
    return new TextDecoder().decode(bytes);
  }

  dispose(): void {
    this.encoding?.free?.();
    this.encoding = null;
  }

  private warnOnce(message: string): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.onWarning?.(message);
  }
}

/**
 * 工厂函数：按 model 创建并返回 Tokenizer 实例。
 *
 * 首选 `TiktokenTokenizer`；若 tiktoken 不可用，内部会自动降级到字节估算。
 */
export const createTiktokenTokenizer = (
  model: string,
  onWarning?: (message: string) => void,
): Tokenizer => new TiktokenTokenizer(model, onWarning);
