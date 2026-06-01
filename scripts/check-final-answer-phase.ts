#!/usr/bin/env bun
/**
 * P-补丁 gate: tool-use final-answer LLM must not live in OutputPhase.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const outputPath = join(ROOT, "packages/core/src/engine/phases/output.ts");
const output = readFileSync(outputPath, "utf8");
if (output.includes('purpose: "final-answer"')) {
  console.error(
    "[check-final-answer-phase] output.ts must not emit final-answer LLM calls; use candidate-answer.ts",
  );
  process.exit(1);
}
console.log("[check-final-answer-phase] OK");
