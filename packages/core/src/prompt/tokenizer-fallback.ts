/**
 * Tokenizer 接口（同步）。
 *
 * 按 detailed-design §11.4 规约：tokenizer 在创建时绑定单个 model，调用方法同步返回。
 */
export interface TokenizerLike {
  count(text: string): number;
  encode(text: string): number[];
  decode(tokens: number[]): string;
  dispose?(): void;
}

/**
 * tiktoken 不可用时的字节估算实现（同步）。
 */
export class ByteEstimateTokenizer implements TokenizerLike {
  count(text: string): number {
    if (!text) {
      return 0;
    }
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  }

  encode(text: string): number[] {
    if (!text) {
      return [];
    }
    return [...new TextEncoder().encode(text)].map((byte) => Number(byte));
  }

  decode(tokens: number[]): string {
    return new TextDecoder().decode(Uint8Array.from(tokens));
  }
}
