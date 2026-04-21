import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { FileBackend } from "../../src/backends/file";
import { TerminalBackend } from "../../src/backends/terminal";
import { WebBackend } from "../../src/backends/web";
import { cleanupTempDir, createTempDir } from "../helpers";

const context = {
  requestId: "req",
  sessionId: "sess",
  traceId: "trace",
  principal: {},
  budget: {},
  scopes: [],
};

describe("backends", () => {
  let root = "";
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await createTempDir();
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 })) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupTempDir(root);
  });

  it("terminal backend executes commands", async () => {
    const backend = new TerminalBackend();
    const result = await backend.execute(
      { taskId: "t", payload: { command: "echo", args: ["hello"] } },
      context,
    );
    expect(result.success).toBe(true);
  });

  it("file backend writes and reads content", async () => {
    const backend = new FileBackend();
    await backend.execute(
      {
        taskId: "t",
        payload: { operation: "write", path: `${root}/a.txt`, content: "hi", createDirs: true },
      },
      context,
    );
    expect(await readFile(`${root}/a.txt`, "utf8")).toBe("hi");
  });

  it("web backend fetches remote content", async () => {
    const backend = new WebBackend();
    const result = await backend.execute(
      { taskId: "t", payload: { url: "https://example.com" } },
      context,
    );
    expect(result.success).toBe(true);
  });
});
