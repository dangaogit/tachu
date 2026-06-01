import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runShellExecutor } from "../../src/tools/run-shell/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("run-shell executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("runs command and captures output", async () => {
    const result = await runShellExecutor(
      { command: "echo", args: ["hello"] },
      createToolContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("returns non-zero code for failing command", async () => {
    const result = await runShellExecutor(
      { command: "sh", args: ["-c", "exit 3"] },
      createToolContext(root),
    );
    expect(result.exitCode).toBe(3);
  });

  it("throws on empty command", async () => {
    await expect(
      runShellExecutor({ command: "   " }, createToolContext(root)),
    ).rejects.toMatchObject({ code: "VALIDATION_EMPTY_COMMAND" });
  });

  it("rejects cwd that escapes workspace root", async () => {
    await expect(
      runShellExecutor({ command: "pwd", cwd: "../outside" }, createToolContext(root)),
    ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
  });

  it("passes explicit env values to command", async () => {
    const result = await runShellExecutor(
      {
        command: "sh",
        args: ["-c", "printf %s \"$TACHU_TEST_ENV\""],
        env: { TACHU_TEST_ENV: "ok" },
      },
      createToolContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });
});
