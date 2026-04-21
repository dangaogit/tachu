import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { McpStdioAdapter } from "../../src/mcp/stdio-adapter";
import { cleanupTempDir, createTempDir } from "../helpers";

describe("McpStdioAdapter integration", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await writeFile(`${root}/hello.txt`, "hello");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("connects to @modelcontextprotocol/server-filesystem", async () => {
    const adapter = new McpStdioAdapter({
      command: "bunx",
      args: ["@modelcontextprotocol/server-filesystem", root],
      serverId: "fs",
    });

    await adapter.connect("");
    try {
      const tools = await adapter.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const toolNames = tools.map((tool) => tool.name);

      if (toolNames.includes("list_directory")) {
        const result = await adapter.executeTool("list_directory", { path: root });
        expect(result).toBeDefined();
      } else if (toolNames.includes("read_file")) {
        const result = await adapter.executeTool("read_file", { path: `${root}/hello.txt` });
        expect(result).toBeDefined();
      } else {
        const result = await adapter.executeTool(toolNames[0]!, {});
        expect(result).toBeDefined();
      }
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);
});
