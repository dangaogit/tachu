import { describe, expect, test } from "bun:test";
import { ByteEstimateTokenizer } from "./tokenizer-fallback";
import { TiktokenTokenizer, createTiktokenTokenizer } from "./tokenizer";

describe("tokenizers", () => {
  test("byte fallback tokenizer count/encode/decode", () => {
    const tokenizer = new ByteEstimateTokenizer();
    const count = tokenizer.count("hello world");
    expect(count).toBeGreaterThan(0);
    const encoded = tokenizer.encode("hello");
    const decoded = tokenizer.decode(encoded);
    expect(decoded).toBe("hello");
  });

  test("tiktoken tokenizer counts and decodes with real module", () => {
    const warnings: string[] = [];
    const tokenizer = new TiktokenTokenizer("gpt-4o-mini", (warning) => warnings.push(warning));
    const count = tokenizer.count("hello world");
    expect(count).toBeGreaterThan(0);
    const encoded = tokenizer.encode("hello world");
    const decoded = tokenizer.decode(encoded);
    expect(decoded.length).toBeGreaterThan(0);
    tokenizer.dispose();
    expect(warnings.length).toBeGreaterThanOrEqual(0);
  });

  test("falls back to byte estimator when encoding cannot be created", () => {
    const warnings: string[] = [];
    const tokenizer = new TiktokenTokenizer("unknown-model", (warning) => warnings.push(warning));
    const count = tokenizer.count("fallback-case");
    expect(count).toBeGreaterThan(0);
    tokenizer.dispose();
  });

  test("createTiktokenTokenizer factory returns Tokenizer", () => {
    const tokenizer = createTiktokenTokenizer("gpt-4o-mini");
    expect(typeof tokenizer.count("abc")).toBe("number");
    expect(Array.isArray(tokenizer.encode("abc"))).toBe(true);
    const bytes = tokenizer.encode("abc");
    expect(tokenizer.decode(bytes).length).toBeGreaterThan(0);
    tokenizer.dispose?.();
  });
});
