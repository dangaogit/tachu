#!/usr/bin/env bun
/**
 * gate (): `SemanticIndexPort` / `InMemorySemanticIndex` /
 * `EmbeddingPort` / `semanticIndexPort` / `embeddingPort` must not appear in
 * production source code.
 *
 * Production hosts must use the policy-aware {@link SemanticRetrievalFacade}
 * + {@link EmbeddingRuntime} + {@link VectorIndexAdapter} stack from
 * `@tachu/core`. The patterns below are pre- abstractions retired by
 * Phase III item 10 — they may only appear in:
 * 1. The deprecated definition file (if any is kept for migration docs).
 * 2. Explicitly-marked test fixtures under `**\/__tests__/**`, `**\/testing/**`,
 * or `*.test.ts` files.
 *
 * Anything else exits non-zero so the regression cannot land in production.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/**
 * Explicit allowlist for *non-test* paths that may legitimately reference the
 * deprecated symbols. Empty by default — once the deprecated definitions are
 * deleted, this list should remain empty.
 */
const ALLOWED_DEPRECATED_PATHS = new Set<string>([]);

const PATTERN =
  /\b(?:SemanticIndexPort|InMemorySemanticIndex|EmbeddingPort|semanticIndexPort|embeddingPort)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (!full.endsWith(".ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Return true when a path is a test fixture / unit test file.
 *
 * Heuristics (kept conservative — every additional path means a wider blast
 * radius for accidental re-introductions):
 * - any file under a `__tests__` directory
 * - any file under a `testing` directory (fixtures shared between tests)
 * - any `*.test.ts` / `*.spec.ts` file
 */
function isTestPath(relPath: string): boolean {
  if (relPath.includes("/__tests__/")) return true;
  if (relPath.includes("/testing/")) return true;
  if (relPath.endsWith(".test.ts")) return true;
  if (relPath.endsWith(".spec.ts")) return true;
  return false;
}

const hits: string[] = [];
for (const file of walk(join(ROOT, "packages"))) {
  const rel = file.slice(ROOT.length + 1);
  if (ALLOWED_DEPRECATED_PATHS.has(rel)) continue;
  if (isTestPath(rel)) continue;
  const text = readFileSync(file, "utf8");
 if (PATTERN.test(text)) {
    hits.push(rel);
  }
}

if (hits.length > 0) {
  console.error(
    "[check-semantic-index-port] forbidden production references to deprecated semantic-index symbols:",
  );
  for (const hit of hits) console.error(`  - ${hit}`);
  console.error("");
  console.error(
    "Production hosts must use SemanticRetrievalFacade + EmbeddingRuntime + VectorIndexAdapter.",
  );
  process.exit(1);
}
console.log("[check-semantic-index-port] OK");
