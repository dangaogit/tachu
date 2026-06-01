#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const MAX_LINES = 380;
const files = ["README.md", "README_ZH.md"];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > MAX_LINES) {
    console.error(`[check-readme-facade] FAIL: ${file} has ${lines} lines (max ${MAX_LINES})`);
    process.exit(1);
  }
}

console.log("[check-readme-facade] ok");
