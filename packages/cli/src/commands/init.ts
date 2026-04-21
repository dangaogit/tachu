import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { colorize } from "../renderer/color";
import { isTTY } from "../utils/tty";

const GITIGNORE_ENTRIES = [
  ".tachu/sessions/",
  ".tachu/archive.jsonl",
  ".tachu/events.jsonl",
  ".tachu/vectors.json",
];

const README_RULES = `# Rules

本目录存放 Rule 描述符（\`*.md\` 文件）。

Rule 用于向 LLM 注入硬约束（\`type: rule\`）或软偏好（\`type: preference\`）。

## 示例 frontmatter

\`\`\`yaml
---
name: my-rule
description: 简短描述
kind: rule
type: rule
scope: ["*"]
---

规则正文...
\`\`\`
`;

const README_SKILLS = `# Skills

本目录存放 Skill 描述符（\`SKILL.md\`）。

Skill 采用渐进式加载三层结构：元信息层 / 指令层 / 资源层。

## 约定目录结构

\`\`\`
skill-name/
├── SKILL.md
└── resources/
\`\`\`
`;

const README_TOOLS = `# Tools

本目录存放 Tool 描述符（\`*.md\` 文件）。

Tool 描述符声明工具的输入 Schema、副作用级别和超时。

## 示例 frontmatter

\`\`\`yaml
---
name: my-tool
description: 工具简短描述
kind: tool
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 5000
execute: myToolFunction
inputSchema:
  type: object
  properties:
    path:
      type: string
  required: [path]
---
\`\`\`
`;

const README_AGENTS = `# Agents

本目录存放 Agent 描述符（\`*.md\` 文件）。

Agent 描述符声明子 Agent 的行为指令和可用工具范围。
`;

// 注意：名字必须与 `@tachu/extensions` 内置 `no-sensitive-output` 规则区分，
// 否则用户首次 run 时会触发 "描述符重名" warning（见 D1-LOW-17）。内置的基线规则
// 已经覆盖敏感信息输出约束，这里仅提供"如何写自定义规则"的脚手架示例。
const EXAMPLE_RULE_MD = `---
name: no-sensitive-output-example
description: 示例：项目级自定义规则脚手架（可按需重命名或删除）
kind: rule
type: rule
scope: ["*"]
tags: [example, security]
---

这是一个自定义 rule 描述符示例。建议按项目实际需求改名、调整内容后再启用。

默认的"禁止输出 API Key / 密码 / 证书"约束已经由 \`@tachu/extensions\` 内置
规则 \`no-sensitive-output\` 提供，你无需在此重复声明，除非希望做增强或替换。
`;

const EXAMPLE_TOOL_MD = `---
name: example-custom-tool
description: 示例自定义工具描述符（可删除或按需修改）
kind: tool
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 5000
execute: exampleCustomTool
inputSchema:
  type: object
  properties:
    message:
      type: string
      description: 输入消息
  required: [message]
---

示例工具，接收一条消息并返回处理结果。
`;

/**
 * 根据 provider 名称生成对应的 tachu.config.ts 内容。
 *
 * @param provider provider 名称
 * @returns TypeScript 配置文件内容字符串
 */
function buildConfigContent(provider: string): string {
  const providerModels: Record<string, {
    highReasoning: { provider: string; model: string };
    fastCheap: { provider: string; model: string };
    vision: { provider: string; model: string };
    fallbackOrder: string[];
  }> = {
    openai: {
      highReasoning: { provider: "openai", model: "gpt-4o" },
      fastCheap: { provider: "openai", model: "gpt-4o-mini" },
      vision: { provider: "openai", model: "gpt-4o" },
      fallbackOrder: ["openai"],
    },
    anthropic: {
      highReasoning: { provider: "anthropic", model: "claude-opus-4-5" },
      fastCheap: { provider: "anthropic", model: "claude-haiku-3-5" },
      vision: { provider: "anthropic", model: "claude-opus-4-5" },
      fallbackOrder: ["anthropic"],
    },
    mock: {
      highReasoning: { provider: "mock", model: "mock-chat" },
      fastCheap: { provider: "mock", model: "mock-chat" },
      vision: { provider: "mock", model: "mock-chat" },
      fallbackOrder: ["mock"],
    },
  };

  const models = providerModels[provider] ?? providerModels.mock!;

  return `import type { EngineConfig } from '@tachu/core';

const config: EngineConfig = {
  registry: {
    descriptorPaths: ['.tachu/rules', '.tachu/skills', '.tachu/tools', '.tachu/agents'],
    enableVectorIndexing: true,
  },
  runtime: { planMode: false, maxConcurrency: 4, defaultTaskTimeoutMs: 30000, failFast: false },
  memory: {
    contextTokenLimit: 8000,
    compressionThreshold: 0.8,
    headKeep: 6,
    tailKeep: 8,
    archivePath: '.tachu/archive.jsonl',
    vectorIndexLimit: 10000,
  },
  budget: { maxTokens: 50000, maxToolCalls: 50, maxWallTimeMs: 300000 },
  safety: {
    maxInputSizeBytes: 1_000_000,
    maxRecursionDepth: 10,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [
      'ignore previous instructions',
      'system override',
      'reveal hidden prompt',
      'bypass safety',
    ],
  },
  models: {
    capabilityMapping: {
      'high-reasoning': { provider: '${models.highReasoning.provider}', model: '${models.highReasoning.model}' },
      'fast-cheap': { provider: '${models.fastCheap.provider}', model: '${models.fastCheap.model}' },
      'vision': { provider: '${models.vision.provider}', model: '${models.vision.model}' },
      'intent': { provider: '${models.fastCheap.provider}', model: '${models.fastCheap.model}' },
      'planning': { provider: '${models.highReasoning.provider}', model: '${models.highReasoning.model}' },
      'validation': { provider: '${models.fastCheap.provider}', model: '${models.fastCheap.model}' },
    },
    providerFallbackOrder: ${JSON.stringify(models.fallbackOrder)},
  },
  // Provider 连接参数（可选）。
  //
  // 如果你使用官方默认端点 + 标准环境变量（OPENAI_API_KEY / ANTHROPIC_API_KEY
  // / OPENAI_BASE_URL / ANTHROPIC_BASE_URL），可以完全删除下面这段。
  //
  // 典型自定义场景：
  //   - 自建 LLM 网关 / LiteLLM / 反向代理
  //   - Azure OpenAI / 第三方兼容 OpenAI 协议的服务
  //   - 同一机器同时跑多个 provider 而需要不同超时
  //
  // 建议 apiKey 仍然走环境变量，不要硬编码到代码中。
  //
  // providers: {
  //   openai: {
  //     // apiKey: process.env.OPENAI_API_KEY,
  //     // baseURL: 'https://your-gateway.example.com/v1',
  //     // organization: 'org-xxxx',
  //     // project: 'proj_xxxx',
  //     // timeoutMs: 60_000,
  //   },
  //   anthropic: {
  //     // apiKey: process.env.ANTHROPIC_API_KEY,
  //     // baseURL: 'https://your-gateway.example.com/anthropic',
  //     // timeoutMs: 60_000,
  //   },
  // },
  //
  // MCP Server 装配（可选）。字段命名对齐 OpenAI Agents SDK 与通用
  // MCP 客户端的 \`mcp.json\` / \`mcp_servers\` 约定，既有配置可直接迁移：
  //
  //   - stdio（本地进程）：声明 \`command\` + \`args\`（+ 可选 \`env\` / \`cwd\`）
  //   - sse（远端 HTTP/SSE）：声明 \`url\`（+ 可选 \`headers\`）
  //
  // 远端工具会以 \`<serverId>__<原工具名>\` 的 namespaced 形态注入
  // DescriptorRegistry，多个 server 之间不会互相冲突，也不依赖远端自身
  // 的命名规范。单个 server 连接失败只会在 stderr 打印一条警告，主流程
  // 不受影响。完整字段参考 @tachu/core 的 McpServerConfig 注释。
  //
  // mcpServers: {
  //   fs: {
  //     command: 'npx',
  //     args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  //     env: { ...process.env },
  //   },
  //   remoteKb: {
  //     url: 'https://mcp.example.com/sse/',
  //     headers: { Authorization: 'Bearer \${process.env.MCP_TOKEN ?? ""}' },
  //     timeoutMs: 50_000,
  //     connectTimeoutMs: 10_000,
  //     // description: '项目文档检索示例接口',
  //     // keywords: ['文档', 'docs'],
  //     // expandOnKeywordMatch: true,
  //     // allowTools: ['getStatus'],
  //     // denyTools: ['dangerousOp'],
  //     // requiresApproval: true,
  //     // disabled: false,
  //   },
  // },
  observability: { enabled: true, maskSensitiveData: true },
  hooks: { writeHookTimeout: 5000, failureBehavior: 'continue' },
};

export default config;
`;
}

/**
 * `tachu init` 命令实现。
 *
 * 在目标目录生成 `.tachu/` 骨架 + `tachu.config.ts` + `.gitignore` 条目。
 */
export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "初始化 Tachu 项目配置（生成 .tachu/ 目录骨架与 tachu.config.ts）",
  },
  args: {
    template: {
      type: "string",
      description: "模板名称（minimal | full，默认 minimal）",
      default: "minimal",
    },
    force: {
      type: "boolean",
      description: "已存在时覆盖（不询问）",
      default: false,
    },
    path: {
      type: "string",
      description: "目标目录（默认 CWD）",
      default: "",
    },
    provider: {
      type: "string",
      description: "初始默认 Provider（openai | anthropic | mock，默认 mock）",
      default: "mock",
    },
    "no-examples": {
      type: "boolean",
      description: "不生成示例描述符",
      default: false,
    },
  },
  async run({ args }) {
    const targetDir = resolve(args.path || process.cwd());
    const tachyDir = join(targetDir, ".tachu");
    const configPath = join(targetDir, "tachu.config.ts");
    const gitignorePath = join(targetDir, ".gitignore");
    const template = (args.template as string) || "minimal";
    const provider = (args.provider as string) || "mock";
    const noExamples = Boolean(args["no-examples"]);

    // 检查已存在
    if (existsSync(tachyDir) || existsSync(configPath)) {
      if (!args.force) {
        if (!isTTY()) {
          console.error(
            colorize(
              `错误：${targetDir} 已有 tachu 配置。使用 --force 强制覆盖。`,
              "red",
            ),
          );
          process.exit(1);
        }
        // TTY：询问用户
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          colorize(`目标目录已存在 tachu 配置，是否覆盖？(y/N) `, "yellow"),
        );
        rl.close();
        if (answer.toLowerCase() !== "y") {
          console.log(colorize("已取消。", "gray"));
          return;
        }
      }
    }

    // 创建目录结构
    const dirs = [
      join(tachyDir, "rules"),
      join(tachyDir, "skills"),
      join(tachyDir, "tools"),
      join(tachyDir, "agents"),
      join(tachyDir, "sessions"),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }

    // README 文件
    await writeFile(join(tachyDir, "rules", "README.md"), README_RULES, "utf8");
    await writeFile(join(tachyDir, "skills", "README.md"), README_SKILLS, "utf8");
    await writeFile(join(tachyDir, "tools", "README.md"), README_TOOLS, "utf8");
    await writeFile(join(tachyDir, "agents", "README.md"), README_AGENTS, "utf8");
    await writeFile(join(tachyDir, "sessions", ".gitkeep"), "", "utf8");

    // 示例描述符（full 模板或未禁用）
    if (template === "full" || !noExamples) {
      await writeFile(
        join(tachyDir, "rules", "no-sensitive-output-example.md"),
        EXAMPLE_RULE_MD,
        "utf8",
      );
    }
    if (template === "full" && !noExamples) {
      await writeFile(join(tachyDir, "tools", "example-custom-tool.md"), EXAMPLE_TOOL_MD, "utf8");
    }

    // tachu.config.ts
    await writeFile(configPath, buildConfigContent(provider), "utf8");

    // .gitignore：追加条目
    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = await readFile(gitignorePath, "utf8");
    }
    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !gitignoreContent.includes(entry),
    );
    if (missingEntries.length > 0) {
      const addition = "\n# Tachu\n" + missingEntries.join("\n") + "\n";
      await writeFile(gitignorePath, gitignoreContent + addition, "utf8");
    }

    // 输出成功信息
    console.log(colorize("\n✓ Tachu 项目初始化完成！\n", "green"));
    console.log(`  目录：${colorize(tachyDir, "cyan")}`);
    console.log(`  配置：${colorize(configPath, "cyan")}`);
    console.log(`  模板：${colorize(template, "cyan")}`);
    console.log(`  Provider：${colorize(provider, "cyan")}`);
    console.log(colorize("\n运行 `tachu run \"你好\"` 开始使用。\n", "gray"));
  },
});
