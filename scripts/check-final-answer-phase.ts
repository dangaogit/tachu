#!/usr/bin/env bun
/**
 * ADR-0006 gate: tool-use candidate answers must not go through a separate
 * final-answer LLM rewrite. `terminalDraft` (written by the loop under the
 * full assembled prompt) is the candidate answer directly — never re-synthesize
 * it via `output.ts`, and never reintroduce a final-answer LLM call in
 * `candidate-answer.ts`.
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

const candidateAnswerPath = join(
  ROOT,
  "packages/core/src/engine/phases/candidate-answer.ts",
);
const candidateAnswer = readFileSync(candidateAnswerPath, "utf8");
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/purpose:\s*"final-answer"/, 'purpose: "final-answer" telemetry payload'],
  [/generateToolUseFinalAnswer/, "generateToolUseFinalAnswer (final-answer writer LLM)"],
  [/env\.modelRouter\.resolve\(/, "a modelRouter.resolve() call (LLM route resolution)"],
  [/env\.providers\.get\(/, "an env.providers.get() call (provider LLM invocation)"],
];
for (const [pattern, label] of FORBIDDEN_PATTERNS) {
  if (pattern.test(candidateAnswer)) {
    console.error(
      `[check-final-answer-phase] candidate-answer.ts must not reintroduce a final-answer LLM call: found ${label}`,
    );
    process.exit(1);
  }
}

console.log("[check-final-answer-phase] OK");
