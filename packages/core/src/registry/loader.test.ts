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
version: 1.2.0
displayName: Read File
execute: readFile
x-acme:
  owner: core
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
    expect(registry.get("tool", "read-file", "1.2.0")?.displayName).toBe("Read File");
    const toolDescriptor = registry.get("tool", "read-file") as unknown as Record<string, unknown>;
    expect((toolDescriptor["x-acme"] as { owner: string }).owner).toBe("core");
    expect(registry.get("agent", "review-agent")?.maxDepth).toBe(2);
    expect(registry.get("skill", "explain-code")?.instructions).toContain("skill instructions");
  });

  test("parses rule activation and defaults to always when omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-activation-"));
    await mkdir(join(root, "rules"), { recursive: true });
    await writeFile(
      join(root, "rules", "default.md"),
      `---
kind: rule
name: rule-default
description: d
type: rule
---

body`,
      "utf8",
    );
    await writeFile(
      join(root, "rules", "path.md"),
      `---
kind: rule
name: rule-path
description: d
type: rule
activation:
  mode: path
  globs: ["src/**/*.ts"]
---

body`,
      "utf8",
    );
    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    expect(registry.get("rule", "rule-default")?.activation).toEqual({ mode: "always" });
    expect(registry.get("rule", "rule-path")?.activation).toEqual({
      mode: "path",
      globs: ["src/**/*.ts"],
    });
  });

  test("fail-closes on unknown activation mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-bad-activation-"));
    await mkdir(join(root, "rules"), { recursive: true });
    await writeFile(
      join(root, "rules", "bad.md"),
      `---
kind: rule
name: rule-bad
description: d
type: rule
activation:
  mode: turnStop
---

body`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toBeInstanceOf(ValidationError);
  });

  test("fail-closes on path activation without globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-path-noglob-"));
    await mkdir(join(root, "rules"), { recursive: true });
    await writeFile(
      join(root, "rules", "bad.md"),
      `---
kind: rule
name: rule-path-bad
description: d
type: rule
activation:
  mode: path
---

body`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toBeInstanceOf(ValidationError);
  });

  test("fail-closes when a tool declares an unknown sideEffect", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-bad-tool-side-effect-"));
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(
      join(root, "tools", "bad.md"),
      `---
kind: tool
name: bad-tool
description: d
sideEffect: bogus
execute: runBadTool
---

body`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toThrow(
      /tool "bad-tool" .*bad\.md.*sideEffect/,
    );
  });

  test("loads a tool that declares a write sideEffect", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-write-tool-side-effect-"));
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(
      join(root, "tools", "write-tool.md"),
      `---
kind: tool
name: write-tool
description: d
sideEffect: write
execute: runWriteTool
---

body`,
      "utf8",
    );
    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    expect(registry.get("tool", "write-tool")?.sideEffect).toBe("write");
  });

  test("fail-closes when an agent declares an unknown sideEffect", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-bad-agent-side-effect-"));
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(
      join(root, "agents", "bad.md"),
      `---
kind: agent
name: bad-agent
description: d
sideEffect: bogus
---

instructions`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toThrow(
      /agent "bad-agent" .*bad\.md.*sideEffect/,
    );
  });

  test("fail-closes when a skill declares an unknown activation mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-bad-skill-activation-"));
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(
      join(root, "skills", "bad.md"),
      `---
name: bad-skill
description: d
activation:
  mode: typo
---

instructions`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toThrow(
      /"bad-skill" .*bad\.md.*activation\.mode/,
    );
  });

  test("defaults a skill with no activation to semantic", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-missing-skill-activation-"));
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(
      join(root, "skills", "missing-activation.md"),
      `---
name: missing-activation
description: d
---

instructions`,
      "utf8",
    );
    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    expect(registry.get("skill", "missing-activation")?.activation).toEqual({ mode: "semantic" });
  });

  test("fail-closes when a descriptor declares an unknown kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-bad-kind-"));
    await writeFile(
      join(root, "bad-kind.md"),
      `---
kind: rulez
name: bad-kind
description: d
execute: runBadKind
---

body`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toThrow(
      /descriptor "bad-kind" .*bad-kind\.md.*kind/,
    );
  });

  test("infers descriptor kind when kind is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-infer-kind-"));
    await writeFile(
      join(root, "inferred-tool.md"),
      `---
name: inferred-tool
description: d
execute: runInferredTool
---

body`,
      "utf8",
    );
    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    expect(registry.get("tool", "inferred-tool")?.kind).toBe("tool");
  });

  test("fail-closes when kind is absent and field signatures are ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-ambiguous-kind-"));
    await writeFile(
      join(root, "ambiguous.md"),
      `---
name: ambiguous-desc
description: has both tool and agent signatures
execute: runAmbiguous
maxDepth: 2
---

body`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toThrow(
      /descriptor "ambiguous-desc" .*无法确定 kind.*tool\/agent/,
    );
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

  test("discovers skill resources from scripts/references/assets when the file is named SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-resources-"));
    const skillDir = join(root, "skills", "git-workflow");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "scripts", "check.sh"), "#!/bin/sh", "utf8");
    await writeFile(join(skillDir, "references", "guide.md"), "guide", "utf8");
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: git-workflow
description: Git workflow knowledge
resources:
  - path: legacy-frontmatter-should-be-ignored.md
    type: reference
---

instructions`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    const skill = registry.get("skill", "git-workflow");
    expect(skill?.resources).toEqual([
      { path: "references/guide.md" },
      { path: "scripts/check.sh" },
    ]);
  });

  test("does not scan for resources when a skill is a flat .md file (not named SKILL.md)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-flat-skill-"));
    await mkdir(join(root, "skills"), { recursive: true });
    // A sibling skill's own scripts/ dir; must never leak into the flat skill below.
    await mkdir(join(root, "skills", "scripts"), { recursive: true });
    await writeFile(join(root, "skills", "scripts", "unrelated.sh"), "#!/bin/sh", "utf8");
    await writeFile(
      join(root, "skills", "explain-code.md"),
      `---
name: explain-code
description: Explains code snippets
---

instructions`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    const skill = registry.get("skill", "explain-code");
    expect(skill?.resources).toBeUndefined();
  });

  test("parses agentskills.io optional frontmatter fields on a skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-skill-fields-"));
    const skillDir = join(root, "skills", "pdf-processing");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: pdf-processing
description: Extract PDF text, fill forms, merge files
license: Apache-2.0
compatibility: Requires python3 and pypdf
metadata:
  author: acme
  version: "1.0"
allowed-tools: "run-shell(python3 *) read-file"
---

instructions`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    const skill = registry.get("skill", "pdf-processing");
    expect(skill?.license).toBe("Apache-2.0");
    expect(skill?.compatibility).toBe("Requires python3 and pypdf");
    expect(skill?.metadata).toEqual({ author: "acme", version: "1.0" });
    expect(skill?.allowedTools).toEqual(["run-shell(python3 *)", "read-file"]);
  });

  test("accepts allowed-tools as a YAML list", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-skill-allowed-list-"));
    const skillDir = join(root, "skills", "deploy");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: deploy
description: Deploy the application
allowed-tools:
  - run-shell
  - read-file
---

instructions`,
      "utf8",
    );

    const registry = new DescriptorRegistry();
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(root);
    const skill = registry.get("skill", "deploy");
    expect(skill?.allowedTools).toEqual(["run-shell", "read-file"]);
  });

  test("rejects a descriptor name with an invalid format (uppercase)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-loader-invalid-name-"));
    await writeFile(
      join(root, "bad.md"),
      `---
kind: rule
name: Bad-Name
description: invalid name format
type: rule
---

content`,
      "utf8",
    );
    const loader = new RegistryLoader(new DescriptorRegistry());
    await expect(loader.loadFromDirectory(root)).rejects.toBeInstanceOf(ValidationError);
  });
});

