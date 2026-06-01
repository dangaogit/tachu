#!/usr/bin/env bun
/**
 * Fail CI when internal codenames or retired doc paths reappear in tracked sources.
 */
import { $ } from "bun";

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

let failed = false;

for (const { reason, pattern } of patterns) {
  const proc = Bun.spawn(
    ["rg", "-n", pattern, ...roots, "-g", "!node_modules/**", "-g", "!dist/**", "-g", "!.cursor/**", "-g", "!.review_*", "-g", "!CL/**", "-g", "!scripts/check-no-internal-codenames.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code > 1) {
    console.error(`[check-no-internal-codenames] rg error for ${pattern}: exit ${code}`);
    process.exit(2);
  }
  if (out.trim().length > 0) {
    failed = true;
    console.error(`\n[check-no-internal-codenames] FAIL: ${reason} (${pattern})\n${out.trim()}\n`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("[check-no-internal-codenames] ok");
