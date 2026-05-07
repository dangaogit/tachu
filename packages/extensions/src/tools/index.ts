import type { ToolDescriptor } from "@tachu/core";
import type { ToolExecutor } from "./shared";
import { readFileExecutor } from "./read-file/executor";
import { writeFileExecutor } from "./write-file/executor";
import { listDirExecutor } from "./list-dir/executor";
import { searchCodeExecutor } from "./search-code/executor";
import { fetchUrlExecutor } from "./fetch-url/executor";
import { runShellExecutor } from "./run-shell/executor";
import { applyPatchExecutor } from "./apply-patch/executor";
import { executeWebFetch } from "./web-fetch";
import { executeWebSearch } from "./web-search";
// 新增工具 — S1 工具层核心
import { editFileExecutor } from "./edit-file/executor";
import { multiEditExecutor } from "./multi-edit/executor";
import { globExecutor } from "./glob/executor";
import { todoWriteExecutor } from "./todo-write/executor";
import { todoReadExecutor } from "./todo-read/executor";
// 新增工具 — S2 Git + 测试诊断
import { gitStatusExecutor } from "./git-status/executor";
import { gitDiffExecutor } from "./git-diff/executor";
import { gitLogExecutor } from "./git-log/executor";
import { gitBlameExecutor } from "./git-blame/executor";
import { gitShowExecutor } from "./git-show/executor";
import { gitBranchExecutor } from "./git-branch/executor";
import { runTypecheckExecutor } from "./run-typecheck/executor";
import { runTestsExecutor } from "./run-tests/executor";

/**
 * 内置工具描述符列表。
 */
export const toolDescriptors: ToolDescriptor[] = [
  {
    kind: "tool",
    name: "read-file",
    description: "读取工作区内的文件内容。支持 offset/limit 分段读取、withLineNumbers 行号注入（默认开启）。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 5000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
        offset: { type: "number", description: "起始行（1-based），默认 1" },
        limit: { type: "number", description: "最多读多少行，默认全文" },
        withLineNumbers: { type: "boolean", description: "是否在每行前插入行号前缀（默认 true）" },
      },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        bytes: { type: "number" },
        totalLines: { type: "number" },
        hasMore: { type: "boolean" },
      },
    },
    execute: "read-file",
  },
  {
    kind: "tool",
    name: "write-file",
    description: "写入工作区内文件内容",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: true,
    timeout: 5000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
        createDirs: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    outputSchema: {
      type: "object",
      properties: { bytesWritten: { type: "number" } },
    },
    execute: "write-file",
  },
  {
    kind: "tool",
    name: "list-dir",
    description: "列出工作区目录内容",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 3000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        maxEntries: { type: "number" },
        pattern: { type: "string" },
      },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { entries: { type: "array" } } },
    execute: "list-dir",
  },
  {
    kind: "tool",
    name: "search-code",
    description: "在工作区内按模式搜索代码",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        fileGlob: { type: "string" },
        maxResults: { type: "number" },
        caseSensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
    outputSchema: { type: "object", properties: { matches: { type: "array" } } },
    execute: "search-code",
  },
  {
    kind: "tool",
    name: "fetch-url",
    description:
      "发送单次 HTTP 请求并返回原始响应体。优先级低于 web-fetch——抓取网页正文请优先用 web-fetch（可触发浏览器渲染与结构化抽取）。",
    sideEffect: "readonly",
    idempotent: false,
    requiresApproval: false,
    timeout: 15000,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
        headers: { type: "object" },
        body: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["url"],
    },
    outputSchema: { type: "object", properties: { status: { type: "number" } } },
    execute: "fetch-url",
  },
  {
    kind: "tool",
    name: "web-fetch",
    description:
      "通过 @tachu/web-fetch-server 远程渲染并结构化抓取 URL：服务端走 Bun.fetch（静态）或 Playwright（浏览器）拉取页面，经 Readability/Turndown 输出标题、正文（markdown/text/html/structured 之一）、可选链接/图片/JSON-LD。renderMode=auto 时可在静态不足时自动升级到浏览器。抓取内容文章、文档、JS 渲染页面请用本工具，而非 fetch-url。",
    sideEffect: "readonly",
    idempotent: false,
    requiresApproval: false,
    timeout: 120000,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标 http(s) URL" },
        renderMode: {
          type: "string",
          enum: ["static", "browser", "auto"],
          description: "渲染模式；默认 auto（静态不足时浏览器重试一次）",
        },
        outputFormat: {
          type: "string",
          enum: ["markdown", "text", "html", "structured"],
          description: "正文形态；默认 markdown",
        },
        includeLinks: { type: "boolean" },
        includeImages: { type: "boolean" },
        includeStructured: { type: "boolean", description: "是否包含 JSON-LD 结构化字段" },
        maxBodyChars: { type: "number", description: "body 字符上限；默认 32768" },
        waitFor: {
          description: "仅 browser：load | domcontentloaded | networkidle | {selector} | {timeMs}",
        },
        waitTimeoutMs: { type: "number", description: "渲染等待超时；默认 15000" },
        userAgent: { type: "string" },
        extraHeaders: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        renderedWith: { type: "string", enum: ["static", "browser"] },
        title: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        wordCount: { type: "number" },
        truncated: { type: "boolean" },
        links: { type: "array" },
        images: { type: "array" },
        structured: { type: "object" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    execute: "web-fetch",
  },
  {
    kind: "tool",
    name: "web-search",
    description:
      "通过 @tachu/web-fetch-server 调用 /v1/search：服务端编排搜索 provider 与可选 top-N 抽取。v0.1 默认 provider 为 stub，未配置真实 provider 时返回 503 PROVIDER_NOT_CONFIGURED。",
    sideEffect: "readonly",
    idempotent: false,
    requiresApproval: false,
    timeout: 120000,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询词（必填）" },
        maxResults: { type: "number", description: "返回条数；默认 10，上限 30" },
        language: { type: "string" },
        region: { type: "string" },
        timeRange: { type: "string", enum: ["day", "week", "month", "year"] },
        safeSearch: { type: "string", enum: ["off", "moderate", "strict"] },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
        fetchTopN: { type: "number", description: "对前 N 条结果执行抽取；0 表示不抽取；上限 5" },
        fetchOptions: { type: "object", additionalProperties: true },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        provider: { type: "string" },
        results: { type: "array" },
        totalResults: { type: "number" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    execute: "web-search",
  },
  {
    kind: "tool",
    name: "run-shell",
    description: "在受控环境中执行 shell 命令",
    sideEffect: "irreversible",
    idempotent: false,
    requiresApproval: true,
    timeout: 30000,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
        durationMs: { type: "number" },
      },
    },
    execute: "run-shell",
  },
  {
    kind: "tool",
    name: "apply-patch",
    description: "应用 unified diff 补丁并支持失败回滚。支持上下文行宽容匹配（trim + ±3 行偏移）。",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: true,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string" },
        basePath: { type: "string" },
      },
      required: ["patch"],
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "array" },
        success: { type: "boolean" },
      },
    },
    execute: "apply-patch",
  },
  // ─── S1：编辑工具 ──────────────────────────────────────────────────────────
  {
    kind: "tool",
    name: "edit-file",
    description: "在文件中替换精确字符串片段。oldString 必须在文件中唯一（或配合 replaceAll）。改前会校验唯一性，失败时返回 matchCount 方便 LLM 调整上下文。fuzzy 默认 true，允许行首尾空白差异。",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: true,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string", description: "要被替换的精确原始内容（含缩进/换行）" },
        newString: { type: "string", description: "替换后的新内容" },
        replaceAll: { type: "boolean", description: "true 时替换所有匹配，不做唯一性校验" },
        fuzzy: { type: "boolean", description: "允许 oldString 行首尾空白差异（默认 true）" },
      },
      required: ["path", "oldString", "newString"],
    },
    outputSchema: {
      type: "object",
      properties: {
        replaced: { type: "number" },
        matchCount: { type: "number" },
      },
    },
    execute: "edit-file",
  },
  {
    kind: "tool",
    name: "multi-edit",
    description: "在同一文件中原子地应用多处字符串替换。任一替换失败则全部回滚，不写磁盘。",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: true,
    timeout: 15000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldString: { type: "string" },
              newString: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldString", "newString"],
          },
        },
        fuzzy: { type: "boolean" },
      },
      required: ["path", "edits"],
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "number" },
        total: { type: "number" },
        results: { type: "array" },
      },
    },
    execute: "multi-edit",
  },
  {
    kind: "tool",
    name: "glob",
    description: "按 glob 模式查找工作区内的文件路径。只返回路径，不读文件内容。适合探索项目结构、定位特定类型文件。例：pattern=\"**/*.test.ts\"",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 15000,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式，如 **/*.ts" },
        cwd: { type: "string", description: "搜索根（默认 workspaceRoot）" },
        ignore: { type: "array", items: { type: "string" }, description: "排除 pattern（默认排除 node_modules/.git）" },
        maxResults: { type: "number", description: "默认 1000" },
      },
      required: ["pattern"],
    },
    outputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" } },
        truncated: { type: "boolean" },
        matchCount: { type: "number" },
      },
    },
    execute: "glob",
  },
  {
    kind: "tool",
    name: "todo-write",
    description: "创建或更新会话任务清单（持久化到磁盘）。merge=true 时按 id 合并，false 时全量覆盖。用于追踪复杂多步任务的进度。",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: false,
    timeout: 5000,
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: { type: "boolean", description: "默认 true；false 时全量覆盖" },
      },
      required: ["todos"],
    },
    outputSchema: {
      type: "object",
      properties: { total: { type: "number" }, written: { type: "number" } },
    },
    execute: "todo-write",
  },
  {
    kind: "tool",
    name: "todo-read",
    description: "读取当前会话的任务清单。返回全部或按状态过滤的任务列表。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 3000,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "cancelled", "all"],
          description: "过滤状态，默认 all",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        todos: { type: "array" },
        total: { type: "number" },
      },
    },
    execute: "todo-read",
  },
  // ─── S2：Git 工具组 ─────────────────────────────────────────────────────────
  {
    kind: "tool",
    name: "git-status",
    description: "获取 git 工作区状态：当前分支、ahead/behind、staged/unstaged/untracked 文件列表。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
    outputSchema: { type: "object" },
    execute: "git-status",
  },
  {
    kind: "tool",
    name: "git-diff",
    description: "获取 git diff，支持 staged（暂存区）、ref 范围、指定文件。返回结构化 FileDiff 列表。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 15000,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string", description: "限定文件路径" },
        staged: { type: "boolean", description: "true 时等价于 git diff --staged" },
        ref: { type: "string", description: "如 HEAD~1, abc123..def456" },
        context: { type: "number", description: "context lines，默认 3" },
        maxBytes: { type: "number", description: "输出字节上限，默认 32768" },
      },
    },
    outputSchema: { type: "object" },
    execute: "git-diff",
  },
  {
    kind: "tool",
    name: "git-log",
    description: "获取 git 提交历史。支持 limit/since/until/author/path 过滤，返回结构化 commit 列表。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        limit: { type: "number", description: "默认 20，上限 100" },
        since: { type: "string", description: "如 '2 weeks ago', '2026-01-01'" },
        until: { type: "string" },
        author: { type: "string" },
        path: { type: "string", description: "只看影响此路径的 commits" },
        ref: { type: "string", description: "起点 ref，默认 HEAD" },
        oneline: { type: "boolean", description: "只返回 hash + subject" },
      },
    },
    outputSchema: { type: "object" },
    execute: "git-log",
  },
  {
    kind: "tool",
    name: "git-blame",
    description: "查看文件每行的最后修改者和 commit。支持行范围过滤。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 15000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        cwd: { type: "string" },
        startLine: { type: "number", description: "1-based，默认 1" },
        endLine: { type: "number", description: "1-based，默认文件尾" },
      },
      required: ["path"],
    },
    outputSchema: { type: "object" },
    execute: "git-blame",
  },
  {
    kind: "tool",
    name: "git-show",
    description: "查看单个 git commit 的元信息和 diff。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "commit hash, tag, HEAD~1 等" },
        cwd: { type: "string" },
        maxBytes: { type: "number", description: "diff 输出上限，默认 32768" },
      },
      required: ["ref"],
    },
    outputSchema: { type: "object" },
    execute: "git-show",
  },
  {
    kind: "tool",
    name: "git-branch",
    description: "列出本地（或含远端）分支，包含 current、upstream、ahead/behind 信息。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 10000,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        all: { type: "boolean", description: "true 时含远端分支，默认 false" },
      },
    },
    outputSchema: { type: "object" },
    execute: "git-branch",
  },
  // ─── S2：测试诊断 ──────────────────────────────────────────────────────────
  {
    kind: "tool",
    name: "run-typecheck",
    description: "对工作区运行 TypeScript 类型检查（tsc --noEmit 或 package.json 的 typecheck script）。返回结构化错误列表，适合改完代码后验证是否引入类型错误。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 120000,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        tsconfig: { type: "string", description: "tsconfig 路径，默认自动查找" },
        maxErrors: { type: "number", description: "返回错误条数上限，默认 50" },
      },
    },
    outputSchema: { type: "object" },
    execute: "run-typecheck",
  },
  {
    kind: "tool",
    name: "run-tests",
    description: "运行工作区的测试套件（bun test 或 package.json test script）。返回结构化通过/失败/跳过数和失败用例详情。",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 180000,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        filter: { type: "string", description: "测试名过滤" },
        file: { type: "string", description: "只跑指定文件" },
        maxFailures: { type: "number", description: "失败用例返回上限，默认 20" },
        timeout: { type: "number", description: "进程超时 ms，默认 60000" },
      },
    },
    outputSchema: { type: "object" },
    execute: "run-tests",
  },
];

/**
 * 工具执行函数注册表。
 */
export const toolExecutors: Record<string, ToolExecutor> = {
  // 原有工具
  "read-file": readFileExecutor as ToolExecutor,
  "write-file": writeFileExecutor as ToolExecutor,
  "list-dir": listDirExecutor as ToolExecutor,
  "search-code": searchCodeExecutor as ToolExecutor,
  "fetch-url": fetchUrlExecutor as ToolExecutor,
  "web-fetch": executeWebFetch as ToolExecutor,
  "web-search": executeWebSearch as ToolExecutor,
  "run-shell": runShellExecutor as ToolExecutor,
  "apply-patch": applyPatchExecutor as ToolExecutor,
  // S1：编辑工具
  "edit-file": editFileExecutor as ToolExecutor,
  "multi-edit": multiEditExecutor as ToolExecutor,
  "glob": globExecutor as ToolExecutor,
  "todo-write": todoWriteExecutor as ToolExecutor,
  "todo-read": todoReadExecutor as ToolExecutor,
  // S2：Git 工具组
  "git-status": gitStatusExecutor as ToolExecutor,
  "git-diff": gitDiffExecutor as ToolExecutor,
  "git-log": gitLogExecutor as ToolExecutor,
  "git-blame": gitBlameExecutor as ToolExecutor,
  "git-show": gitShowExecutor as ToolExecutor,
  "git-branch": gitBranchExecutor as ToolExecutor,
  // S2：测试诊断
  "run-typecheck": runTypecheckExecutor as ToolExecutor,
  "run-tests": runTestsExecutor as ToolExecutor,
};

export type { ToolExecutor, ToolExecutionContext } from "./shared";
