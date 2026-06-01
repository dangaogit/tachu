#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const forbidden = "findExplicitToolMentions";
const result = spawnSync("git", ["grep", "-n", forbidden, "--", "packages"], {
  encoding: "utf8",
});

if (result.status === 0) {
  process.stderr.write(
    `[reverse-grep] forbidden legacy explicit tool mention helper found:\n${result.stdout}`,
  );
  process.exit(1);
}

if (result.status === 1) {
  process.exit(0);
}

process.stderr.write(result.stderr || "[reverse-grep] git grep failed\n");
process.exit(result.status ?? 2);
