import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillDescriptor } from "@tachu/core";
import { scanDescriptors } from "./descriptor-scanner";

let tmpDir: string;

async function makeTachyDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-scan-"));
  const tachyDir = join(tmpDir, ".tachu");
  await mkdir(join(tachyDir, "rules"), { recursive: true });
  await mkdir(join(tachyDir, "skills"), { recursive: true });
  await mkdir(join(tachyDir, "tools"), { recursive: true });
  await mkdir(join(tachyDir, "agents"), { recursive: true });
  return tachyDir;
}

describe("scanDescriptors", () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("空 .tachu/ 目录不抛出", async () => {
    const tachyDir = await makeTachyDir();
    const registry = await scanDescriptors(tachyDir, false);
    expect(registry).toBeDefined();
  });

  it("扫描 rules 目录并注册描述符", async () => {
    const tachyDir = await makeTachyDir();
    const ruleMd = `---
name: test-rule
description: 测试规则
kind: rule
type: rule
scope: ["*"]
---

测试规则内容。
`;
    await writeFile(join(tachyDir, "rules", "test-rule.md"), ruleMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const rule = registry.get("rule", "test-rule");
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe("test-rule");
  });

  it("扫描 tools 目录并注册描述符", async () => {
    const tachyDir = await makeTachyDir();
    const toolMd = `---
name: test-tool
description: 测试工具
kind: tool
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 5000
execute: testTool
inputSchema:
  type: object
  properties:
    path:
      type: string
  required: [path]
---

测试工具内容。
`;
    await writeFile(join(tachyDir, "tools", "test-tool.md"), toolMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const tool = registry.get("tool", "test-tool");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("test-tool");
  });

  it("mountBuiltins=true 时挂载内置 rules 和 tools", async () => {
    const tachyDir = await makeTachyDir();
    const registry = await scanDescriptors(tachyDir, true);
 // 验证内置 tools 存在
    const allDescriptors = registry.list();
    expect(allDescriptors.length).toBeGreaterThan(0);
  });

  it("不存在的子目录被跳过", async () => {
    const tachyDir = await makeTachyDir();
 // agents 目录存在但为空，skills 也空
    const registry = await scanDescriptors(tachyDir, false);
    expect(registry).toBeDefined();
    expect(registry.list().length).toBe(0);
  });

  it("README.md 与 .gitkeep 等脚手架文件被过滤，不产生 '跳过无效描述符' 警告", async () => {
    const tachyDir = await makeTachyDir();
    await writeFile(
      join(tachyDir, "rules", "README.md"),
      "# rules directory\n",
      "utf8",
    );
    await writeFile(join(tachyDir, "tools", ".gitkeep"), "", "utf8");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const registry = await scanDescriptors(tachyDir, false);
      expect(registry.list().length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("跳过无效描述符"))).toBe(false);
  });

  it("缺少 name 或 description 的描述符被跳过并产生警告", async () => {
    const tachyDir = await makeTachyDir();
    const invalidMd = `---
kind: rule
---

无 name / description 的非法描述符。
`;
    await writeFile(join(tachyDir, "rules", "invalid.md"), invalidMd, "utf8");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const registry = await scanDescriptors(tachyDir, false);
      expect(registry.list().length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("跳过无效描述符"))).toBe(true);
  });

  it("重复 name 会触发 '重名覆盖' warning 并保留后注册的版本", async () => {
    const tachyDir = await makeTachyDir();
    const md = (description: string): string => `---
name: duplicated-rule
description: ${description}
kind: rule
type: rule
scope: ["*"]
---

正文内容。
`;
    await writeFile(join(tachyDir, "rules", "a.md"), md("版本一"), "utf8");
    await writeFile(join(tachyDir, "rules", "b.md"), md("版本二"), "utf8");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const registry = await scanDescriptors(tachyDir, false);
      const rule = registry.get("rule", "duplicated-rule");
      expect(rule).not.toBeNull();
      expect(["版本一", "版本二"]).toContain(rule!.description);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("描述符重名"))).toBe(true);
  });

  it("用户 rule 优先：同名内置 rule 被静默跳过，不产生 warning", async () => {
    const tachyDir = await makeTachyDir();
 // no-sensitive-output 为内置 rule 名，此处用户自定义同名版本
    const userRule = `---
name: no-sensitive-output
description: 用户版本-敏感信息输出限制
kind: rule
type: rule
scope: ["*"]
---

用户自定义内容（应覆盖内置）。
`;
    await writeFile(
      join(tachyDir, "rules", "no-sensitive-output.md"),
      userRule,
      "utf8",
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const registry = await scanDescriptors(tachyDir, true);
      const rule = registry.get("rule", "no-sensitive-output");
      expect(rule).not.toBeNull();
 // 应保留用户版本
      expect(rule!.description).toBe("用户版本-敏感信息输出限制");
    } finally {
      console.warn = originalWarn;
    }
 // 用户 vs 内置同名：不应产生 "描述符重名" warning
    expect(warnings.some((w) => w.includes("描述符重名"))).toBe(false);
  });

  it("解析 skill 描述符（kind: skill）", async () => {
    const tachyDir = await makeTachyDir();
    const skillMd = `---
name: test-skill
description: 测试 skill
kind: skill
---

这是 skill 指令内容。
`;
    await writeFile(
      join(tachyDir, "skills", "test-skill.md"),
      skillMd,
      "utf8",
    );
    const registry = await scanDescriptors(tachyDir, false);
    const skill = registry.get("skill", "test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.kind).toBe("skill");
  });

  it("解析 agent 描述符（kind: agent），缺省字段使用默认值", async () => {
    const tachyDir = await makeTachyDir();
    const agentMd = `---
name: test-agent
description: 测试 agent
kind: agent
---

agent 指令正文。
`;
    await writeFile(
      join(tachyDir, "agents", "test-agent.md"),
      agentMd,
      "utf8",
    );
    const registry = await scanDescriptors(tachyDir, false);
    const agent = registry.get("agent", "test-agent");
    expect(agent).not.toBeNull();
    expect(agent!.kind).toBe("agent");
  });

  it("SKILL.md 目录形态：扫描 scripts/ 与 references/ 生成 resources，忽略 frontmatter 手写 resources", async () => {
    const tachyDir = await makeTachyDir();
    const skillDir = join(tachyDir, "skills", "pdf-processing");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "scripts", "x.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await writeFile(join(skillDir, "references", "y.md"), "# ref\n", "utf8");
    const skillMd = `---
name: pdf-processing
description: 处理 PDF 文件
kind: skill
resources:
  - path: fake/should-be-ignored.txt
---

skill 指令内容。
`;
    await writeFile(join(skillDir, "SKILL.md"), skillMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const skill = registry.get("skill", "pdf-processing") as SkillDescriptor | null;
    expect(skill).not.toBeNull();
    expect(skill!.resources).toEqual([
      { path: "references/y.md" },
      { path: "scripts/x.sh" },
    ]);
  });

  it("skill 的 references/ assets/ scripts/ 资源文件不会被当成候选描述符，不产生 '跳过无效描述符' 警告", async () => {
    const tachyDir = await makeTachyDir();
    const skillDir = join(tachyDir, "skills", "pdf-processing");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    // 无 frontmatter（无 name/description）的普通资源文档：
    // 应被 listMarkdownFiles 在目录层面跳过，而不是"扫描到但解析失败后丢弃"。
    const noFrontmatterDoc = "# 参考文档\n\n这是一份没有 YAML frontmatter 的普通说明文档。\n";
    const refFile = join(skillDir, "references", "no-frontmatter.md");
    const assetFile = join(skillDir, "assets", "notes.md");
    await writeFile(refFile, noFrontmatterDoc, "utf8");
    await writeFile(assetFile, noFrontmatterDoc, "utf8");
    const skillMd = `---
name: pdf-processing
description: 处理 PDF 文件
kind: skill
---

skill 指令内容。
`;
    await writeFile(join(skillDir, "SKILL.md"), skillMd, "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const registry = await scanDescriptors(tachyDir, false);
      const skill = registry.get("skill", "pdf-processing");
      expect(skill).not.toBeNull();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("跳过无效描述符"))).toBe(false);
    expect(warnings.some((w) => w.includes(refFile))).toBe(false);
    expect(warnings.some((w) => w.includes(assetFile))).toBe(false);
  });

  it("扁平命名的 skill 文件（非 SKILL.md）不做目录扫描，resources 为 undefined", async () => {
    const tachyDir = await makeTachyDir();
    const skillMd = `---
name: foo
description: 扁平命名的技能
kind: skill
---

skill 指令内容。
`;
    await writeFile(join(tachyDir, "skills", "foo.md"), skillMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const skill = registry.get("skill", "foo") as SkillDescriptor | null;
    expect(skill).not.toBeNull();
    expect(skill!.resources).toBeUndefined();
  });

  it("name 格式不合法（含大写字母）的描述符文件被跳过，不影响 scanDescriptors 整体成功", async () => {
    const tachyDir = await makeTachyDir();
    const invalidMd = `---
name: Invalid-Name
description: name 含大写字母
kind: rule
type: rule
scope: ["*"]
---

正文内容。
`;
    await writeFile(join(tachyDir, "rules", "Invalid-Name.md"), invalidMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    expect(registry.list().length).toBe(0);
    expect(registry.get("rule", "Invalid-Name")).toBeNull();
  });

  it("name 与目录名/文件名不一致时只 warn，不影响加载成功", async () => {
    const tachyDir = await makeTachyDir();
    const ruleMd = `---
name: mismatched-name
description: name 与文件名不一致
kind: rule
type: rule
scope: ["*"]
---

正文内容。
`;
    await writeFile(join(tachyDir, "rules", "actual-file-name.md"), ruleMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const rule = registry.get("rule", "mismatched-name");
    expect(rule).not.toBeNull();
  });

  it("skill 的 license / compatibility / metadata / allowed-tools（空格分隔字符串）frontmatter 被正确解析", async () => {
    const tachyDir = await makeTachyDir();
    const skillMd = `---
name: deploy-helper
description: 部署辅助技能
kind: skill
license: Apache-2.0
compatibility: Requires python3 and pypdf
metadata:
  author: acme
  version: "1.0"
allowed-tools: "run-shell(python3 *) read-file"
---

skill 指令内容。
`;
    await writeFile(join(tachyDir, "skills", "deploy-helper.md"), skillMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const skill = registry.get("skill", "deploy-helper") as SkillDescriptor | null;
    expect(skill).not.toBeNull();
    expect(skill!.license).toBe("Apache-2.0");
    expect(skill!.compatibility).toBe("Requires python3 and pypdf");
    expect(skill!.metadata).toEqual({ author: "acme", version: "1.0" });
    expect(skill!.allowedTools).toEqual(["run-shell(python3 *)", "read-file"]);
  });

  it("skill 的 allowed-tools 支持 YAML 列表写法", async () => {
    const tachyDir = await makeTachyDir();
    const skillMd = `---
name: deploy
description: 部署技能
kind: skill
allowed-tools:
  - run-shell
  - read-file
---

skill 指令内容。
`;
    await writeFile(join(tachyDir, "skills", "deploy.md"), skillMd, "utf8");

    const registry = await scanDescriptors(tachyDir, false);
    const skill = registry.get("skill", "deploy") as SkillDescriptor | null;
    expect(skill).not.toBeNull();
    expect(skill!.allowedTools).toEqual(["run-shell", "read-file"]);
  });
});
