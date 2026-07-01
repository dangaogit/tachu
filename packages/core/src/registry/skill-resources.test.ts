import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkillResources } from "./skill-resources";

describe("discoverSkillResources", () => {
  test("discovers files under scripts/ references/ assets/ with directory-prefixed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-skill-resources-"));
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "references"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "scripts", "check.sh"), "#!/bin/sh\necho ok", "utf8");
    await writeFile(join(root, "references", "guide.md"), "# guide", "utf8");
    await writeFile(join(root, "assets", "template.md"), "template", "utf8");

    const resources = await discoverSkillResources(root);
    expect(resources).toEqual([
      { path: "assets/template.md" },
      { path: "references/guide.md" },
      { path: "scripts/check.sh" },
    ]);
  });

  test("returns an empty array when none of the three subdirectories exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-skill-resources-empty-"));
    const resources = await discoverSkillResources(root);
    expect(resources).toEqual([]);
  });

  test("ignores subdirectories nested inside scripts/references/assets (one level only)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-skill-resources-nested-"));
    await mkdir(join(root, "references", "nested"), { recursive: true });
    await writeFile(join(root, "references", "top.md"), "top", "utf8");
    await writeFile(join(root, "references", "nested", "deep.md"), "deep", "utf8");

    const resources = await discoverSkillResources(root);
    expect(resources).toEqual([{ path: "references/top.md" }]);
  });
});
