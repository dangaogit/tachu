import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors";
import { DescriptorRegistry } from "./registry";
import { RegistryLoader } from "./loader";

describe("RegistryLoader", () => {
  test("parses markdown descriptors and validates frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-"));
    await mkdir(join(root, "rules"), { recursive: true });
    await mkdir(join(root, "tools"), { recursive: true });
    await mkdir(join(root, "agents"), { recursive: true });
    await mkdir(join(root, "skills"), { recursive: true });

    await writeFile(
      join(root, "rules", "r1.md"),
      `---
kind: rule
name: test-rule
description: desc
type: rule
scope: [output]
---

content`,
      "utf8",
    );
    await writeFile(
      join(root, "tools", "read.md"),
      `---
kind: tool
name: read-file
description: read file from workspace
execute: readFile
inputSchema:
  type: object
  properties:
    path:
      type: string
---

tool body`,
      "utf8",
    );
    await writeFile(
      join(root, "agents", "a1.md"),
      `---
kind: agent
name: review-agent
description: do review
maxDepth: 2
availableTools: [read-file]
---

You are a reviewer.`,
      "utf8",
    );
    await writeFile(
      join(root, "skills", "s1.md"),
      `---
name: explain-code
description: explain code snippets
tags: [dev]
---

skill instructions`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    const loaded = await loader.loadFromDirectory(root);
    expect(loaded.length).toBe(4);
    expect(registry.get("rule", "test-rule")).not.toBeNull();
    expect(registry.get("tool", "read-file")?.kind).toBe("tool");
    expect(registry.get("agent", "review-agent")?.maxDepth).toBe(2);
    expect(registry.get("skill", "explain-code")?.instructions).toContain("skill instructions");
  });

  test("rejects invalid frontmatter structure", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-invalid-"));
    await writeFile(
      join(root, "bad.md"),
      `---
kind: tool
description: missing name should fail
execute: 123
---

invalid`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toBeInstanceOf(ValidationError);
  });

  test("reload clears stale entries before reloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-reload-"));
    await writeFile(
      join(root, "first.md"),
      `---
kind: rule
name: keep-a
description: first
type: rule
---

first`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    expect(registry.get("rule", "keep-a")).not.toBeNull();

    await writeFile(
      join(root, "first.md"),
      `---
kind: rule
name: keep-b
description: second
type: rule
---

second`,
      "utf8",
    );
    await loader.reload(root);
    expect(registry.get("rule", "keep-a")).toBeNull();
    expect(registry.get("rule", "keep-b")).not.toBeNull();
  });
});

