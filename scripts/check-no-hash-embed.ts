#!/usr/bin/env bun
/**
 * Anti-regression: production vector adapters under
 * `packages/extensions/src/vector/` must not ship hash/bag-of-words embedding
 * code paths **and** must not accept raw text via `VectorStore.upsert(id,
 * string, …)` or `VectorStore.embed(texts)` shortcuts. The canonical projection
 * pipeline goes through `EmbeddingRuntime` → numeric vectors → `VectorIndexAdapter`.
 *
 * This script fails the CI gate when either pattern surfaces in production source.
 */
import { $ } from "bun";

const targets = ["packages/extensions/src/vector", "packages/core/src/vector"];

interface ForbiddenPattern {
 /** Human-readable reason for the failure. */
  reason: string;
 /** ripgrep pattern (regex). */
  pattern: string;
 /** Optional comma-separated glob list passed via -g. */
  globs?: readonly string[];
}

const patterns: readonly ForbiddenPattern[] = [
  {
    reason: "hash / bag-of-words embedding helpers must not appear in production vector adapters",
    pattern: "embedText|hashToken|bag-of-words",
  },
  {
    reason:
      "VectorStore.embed(texts: string[]) shortcut is retired; production adapters must accept numeric vectors only",
    pattern: "embed\\(texts:\\s*string\\[\\]\\)",
  },
  {
    reason:
      "VectorStore.upsert(id, string, …) shortcut is retired; use VectorIndexAdapter.upsert(points)",
    pattern: "vectorOrText:\\s*number\\[\\]\\s*\\|\\s*string",
  },
  {
    reason: "hash / bag-of-words assembly path must not appear in production vector adapters",
    pattern: "tokenize\\(.*\\)\\.map.*toVector|toVector\\(tokenize",
  },
];

let failed = false;
for (const item of patterns) {
  for (const target of targets) {
    const args = item.globs ?? [];
    const globArgs = args.flatMap((glob) => ["-g", glob]);
    const result = await $`rg -n ${item.pattern} ${globArgs} ${target}`.quiet().nothrow();
    if (result.exitCode === 0) {
      failed = true;
      console.error(`[check-no-hash-embed] ${item.reason}`);
      console.error(result.stdout.toString());
    }
  }
}

if (failed) {
  console.error("[check-no-hash-embed] one or more forbidden patterns surfaced in production vector adapters");
  process.exit(1);
}

console.log(
  `[check-no-hash-embed] OK — no retired text-embedding / hash patterns under ${targets.join(", ")}`,
);
