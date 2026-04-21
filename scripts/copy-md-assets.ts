#!/usr/bin/env bun
/**
 * Copy all *.md assets under src/ into dist/, preserving relative paths.
 *
 * Invoked from each package's `build` script after `tsc` has emitted JS/d.ts.
 * Required so runtime-loaded markdown resources (e.g. @tachu/extensions rule
 * descriptors resolved via `import.meta.dir`) ship inside the published
 * tarball alongside compiled JavaScript.
 *
 * Usage (cwd == package dir):
 *   bun ../../scripts/copy-md-assets.ts
 */
import {
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";

const cwd = process.cwd();
const srcRoot = join(cwd, "src");
const dstRoot = join(cwd, "dist");

if (!existsSync(srcRoot)) {
  console.log(`[copy-md-assets] no src/ in ${cwd}, skipping`);
  process.exit(0);
}

if (!existsSync(dstRoot)) {
  console.error(
    `[copy-md-assets] dist/ missing under ${cwd}. Run \`tsc\` before copying assets.`,
  );
  process.exit(1);
}

let copied = 0;

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const rel = relative(srcRoot, full);
    const target = join(dstRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(full, target);
    copied += 1;
  }
}

walk(srcRoot);
console.log(
  `[copy-md-assets] copied ${copied} markdown asset${copied === 1 ? "" : "s"} ` +
    `from ${relative(cwd, srcRoot)}/ to ${relative(cwd, dstRoot)}/`,
);
