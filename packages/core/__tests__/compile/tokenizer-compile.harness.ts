import { createTiktokenTokenizer } from "../../src/prompt/tokenizer";

const warnings: string[] = [];
const tokenizer = createTiktokenTokenizer("gpt-4o-mini", (warning) => warnings.push(warning));
const count = tokenizer.count("hello world");
tokenizer.dispose?.();

if (warnings.length > 0) {
  console.error(`tokenizer-compile: unexpected warnings: ${warnings.join("; ")}`);
  process.exit(1);
}

if (count !== 2) {
  console.error(`tokenizer-compile: expected 2 tokens, got ${count}`);
  process.exit(1);
}

console.log("tokenizer-compile: ok");
