#!/usr/bin/env bun
/**
 * Fail CI when internal codenames or retired doc paths reappear in tracked sources.
 *
 * Implemented with a git-tracked file scan (no external `rg`/ripgrep dependency)
 * so the gate runs identically on CI runners that do not ship ripgrep.
 */
import { readFileSync } from "node:fs";

const roots = ["packages", "docs", "scripts", "README.md", "README_ZH.md", "CONTRIBUTING.md", "CONTEXT.md", "CHANGELOG.md", "SECURITY.md"];

const patterns: readonly { reason: string; pattern: string }[] = [
  { reason: "internal cube codename", pattern: String.raw`\bcube\b` },
  { reason: "legacy ADR numbering", pattern: String.raw`ADR-\d` },
  { reason: "legacy backlog ticket id", pattern: String.raw`BL-\d` },
  { reason: "removed ADR doc tree", pattern: String.raw`docs/adr/` },
  { reason: "internal plan reference", pattern: String.raw`plan\.md` },
  { reason: "internal task id", pattern: String.raw`s3-i\d` },
  { reason: "internal review workflow", pattern: String.raw`cross-review-agent` },
  { reason: "internal branch codename", pattern: String.raw`phase-iii-closure` },
  { reason: "removed migration doc", pattern: String.raw`alpha7-to-rc` },
];

const SELF = "scripts/check-no-internal-codenames.ts";

function isExcluded(path: string): boolean {
  if (path === SELF) return true;
  if (path.includes("node_modules/")) return true;
  if (path.includes("dist/")) return true;
  if (path.startsWith(".cursor/") || path.includes("/.cursor/")) return true;
  if (path.startsWith(".review_") || path.includes("/.review_")) return true;
  if (path.startsWith("CL/")) return true;
  return false;
}

function isWithinRoots(path: string): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

const lsFiles = Bun.spawnSync(["git", "ls-files", "-z", "--", ...roots]);
if (lsFiles.exitCode !== 0) {
  console.error(`[check-no-internal-codenames] git ls-files failed: ${new TextDecoder().decode(lsFiles.stderr)}`);
  process.exit(2);
}

const files = new TextDecoder()
  .decode(lsFiles.stdout)
  .split("\0")
  .filter((path) => path.length > 0 && isWithinRoots(path) && !isExcluded(path));

let failed = false;

for (const { reason, pattern } of patterns) {
  const regex = new RegExp(pattern);
  const hits: string[] = [];
  for (const file of files) {
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
    console.error(`\n[check-no-internal-codenames] FAIL: ${reason} (${pattern})\n${hits.join("\n")}\n`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("[check-no-internal-codenames] ok");
