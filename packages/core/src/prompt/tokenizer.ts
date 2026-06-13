import type { Tiktoken, TiktokenEncoding, TiktokenModel } from "tiktoken";
import { ByteEstimateTokenizer, type TokenizerLike } from "./tokenizer-fallback";

/**
 * Tokenizer 统一接口（同步）。
 */
export interface Tokenizer extends TokenizerLike {}

// Bun treats `.wasm` imports as static assets and returns the embedded file
// path (string) — NOT a WebAssembly.Module. In source/test mode the path
// points into the local node_modules cache; in `bun build --compile` mode it
// points into $bunfs where the binary embeds the asset automatically.
// Bun's asset loader returns the embedded file path as a string at runtime,
// but the package's .d.ts types it as the WASM export namespace — cast through unknown.
import tiktokenWasmPath from "tiktoken/tiktoken_bg.wasm";

const chooseFallbackEncoding = (model: string): TiktokenEncoding => {
  if (model.includes("gpt-4o") || model.includes("o1") || model.includes("o3")) {
    return "o200k_base";
  }
  return "cl100k_base";
};

type TiktokenAPI = typeof import("tiktoken");

let tiktokenInit: Promise<TiktokenAPI | null> | null = null;

function getOrInitTiktoken(onWarning?: (msg: string) => void): Promise<TiktokenAPI | null> {
  if (tiktokenInit) return tiktokenInit;
  tiktokenInit = (async () => {
    try {
      const { init, ...api } = await import("tiktoken/init");
      await init(async (imports) => {
        // tiktokenWasmPath is an absolute path string — valid in both source
        // mode (node_modules on disk) and compiled mode ($bunfs embedded asset).
        const bytes = await Bun.file(tiktokenWasmPath as unknown as string).arrayBuffer();
        return WebAssembly.instantiate(bytes, imports);
      });
      return api as unknown as TiktokenAPI;
    } catch (err) {
      onWarning?.(
        `tiktoken 加载失败，已降级字节估算: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  })();
  return tiktokenInit;
}

/**
 * 基于 tiktoken 的精确 Tokenizer（同步计数，异步初始化）。
 *
 * 使用 tiktoken/init + Bun 静态资产嵌入模式，支持 `bun build --compile` 独立二进制。
 * 调用 `await tokenizer.ready()` 后可保证精确计数；初始化完成前自动降级到字节估算。
 */
export class TiktokenTokenizer implements Tokenizer {
  private readonly fallback = new ByteEstimateTokenizer();
  private encoding: Tiktoken | null = null;
  private degraded = false;
  private readonly _ready: Promise<void>;

  /**
   * @param model 需要绑定的 model 名（如 `gpt-4o-mini`、`claude-sonnet-4-20250514`）。
   * @param onWarning 降级告警回调。
   */
  constructor(
    private readonly model: string,
    private readonly onWarning?: (message: string) => void,
  ) {
    this._ready = getOrInitTiktoken(onWarning).then((mod) => {
      if (!mod) {
        this.degraded = true;
        return;
      }
      try {
        this.encoding = mod.encoding_for_model(model as TiktokenModel);
      } catch {
        try {
          this.encoding = mod.get_encoding(chooseFallbackEncoding(model));
        } catch {
          this.warnOnce(`tiktoken 无法为模型 ${model} 创建编码，降级为字节估算`);
        }
      }
    });
  }

  /**
   * 等待 tiktoken 初始化完成。测试中 `await tokenizer.ready()` 后可保证精确计数。
   */
  ready(): Promise<void> {
    return this._ready;
  }

  count(text: string): number {
    return this.encoding ? this.encoding.encode(text).length : this.fallback.count(text);
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
    const bytes = this.encoding.decode(Uint32Array.from(tokens));
    return new TextDecoder().decode(bytes);
  }

  dispose(): void {
    this.encoding?.free();
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
