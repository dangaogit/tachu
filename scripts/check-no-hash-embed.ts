#!/usr/bin/env bun
/**
 * Anti-regression: production vector adapters under
 * `packages/extensions/src/vector/` must not ship hash/bag-of-words embedding
 * code paths **and** must not accept raw text via `VectorStore.upsert(id,
 * string, …)` or `VectorStore.embed(texts)` shortcuts. The canonical projection
 * pipeline goes through `EmbeddingRuntime` → numeric vectors → `VectorIndexAdapter`.
 *
 * This script fails the CI gate when either pattern surfaces in production source.
 *
 * Implemented with a git-tracked file scan (no external `rg`/ripgrep dependency)
 * so the gate runs identically on CI runners that do not ship ripgrep.
 */
import { readFileSync } from "node:fs";

const targets = ["packages/extensions/src/vector", "packages/core/src/vector"];

interface ForbiddenPattern {
  /** Human-readable reason for the failure. */
  reason: string;
  /** Regex pattern. */
  pattern: string;
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

function listTrackedFiles(target: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", target]);
  if (result.exitCode !== 0) {
    console.error(`[check-no-hash-embed] git ls-files failed for ${target}: ${new TextDecoder().decode(result.stderr)}`);
    process.exit(2);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path.length > 0);
}

let failed = false;
for (const item of patterns) {
  const regex = new RegExp(item.pattern);
  for (const target of targets) {
    const hits: string[] = [];
    for (const file of listTrackedFiles(target)) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          hits.push(`${file}:${i + 1}:${line}`);
        }
      }
    }
    if (hits.length > 0) {
      failed = true;
      console.error(`[check-no-hash-embed] ${item.reason}`);
      console.error(hits.join("\n"));
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
