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

/**
 * 内置工具描述符列表。
 */
export const toolDescriptors: ToolDescriptor[] = [
  {
    kind: "tool",
    name: "read-file",
    description: "读取工作区内的文件内容",
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 5000,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: { content: { type: "string" }, bytes: { type: "number" } },
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
    description: "应用 unified diff 补丁并支持失败回滚",
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
];

/**
 * 工具执行函数注册表。
 */
export const toolExecutors: Record<string, ToolExecutor> = {
  "read-file": readFileExecutor as ToolExecutor,
  "write-file": writeFileExecutor as ToolExecutor,
  "list-dir": listDirExecutor as ToolExecutor,
  "search-code": searchCodeExecutor as ToolExecutor,
  "fetch-url": fetchUrlExecutor as ToolExecutor,
  "web-fetch": executeWebFetch as ToolExecutor,
  "web-search": executeWebSearch as ToolExecutor,
  "run-shell": runShellExecutor as ToolExecutor,
  "apply-patch": applyPatchExecutor as ToolExecutor,
};

export type { ToolExecutor, ToolExecutionContext } from "./shared";
