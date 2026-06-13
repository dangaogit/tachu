import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harnessPath = join(import.meta.dir, "tokenizer-compile.harness.ts");
const packageRoot = join(import.meta.dir, "../..");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tokenizer bun --compile regression", () => {
  test("createTiktokenTokenizer uses tiktoken in standalone binary", () => {
    const outDir = mkdtempSync(join(tmpdir(), "tachu-tokenizer-compile-"));
    tempDirs.push(outDir);
    const outfile = join(outDir, "tokenizer-harness");

    const build = Bun.spawnSync(
      ["bun", "build", harnessPath, "--compile", `--outfile=${outfile}`],
      { cwd: packageRoot },
    );
    expect(build.exitCode).toBe(0);

    const run = Bun.spawnSync([outfile]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("tokenizer-compile: ok");
  }, 60_000);
});
