import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
