import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";
import { ApprovalStore } from "../approval/approval-store";
import type { ApprovalRecord, ApprovalMatchKind } from "../approval/approval-store";

const getStore = (): ApprovalStore => new ApprovalStore(process.cwd());

const formatDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatMatch = (match: ApprovalMatchKind): string => {
  if (match.kind === "any") return "any";
  if (match.kind === "shellCommand") return `shell: ${match.pattern}`;
  if (match.kind === "argPattern") return `${match.field}: ${match.pattern}`;
  return "unknown";
};

const approvalListCommand = defineCommand({
  meta: { name: "list", description: "列出所有持久化授权记录" },
  args: {
    tool: { type: "string", description: "按工具名过滤", default: "" },
    scope: { type: "string", description: "按 scope 过滤 (project|user)", default: "" },
  },
  async run({ args }) {
    const store = getStore();
    let records = await store.list();

    const toolFilter = args.tool as string;
    const scopeFilter = args.scope as string;

    if (toolFilter) {
      records = records.filter((r) => r.tool === toolFilter);
    }
    if (scopeFilter === "project" || scopeFilter === "user") {
      records = records.filter((r) => r.scope === scopeFilter);
    }

    if (records.length === 0) {
      console.log("暂无授权记录。");
      return;
    }

    const header = [
      "ID".padEnd(38),
      "SCOPE".padEnd(8),
      "TOOL".padEnd(20),
      "MATCH".padEnd(40),
      "CREATED",
    ].join(" ");
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of records) {
      const expired = r.expiresAt !== undefined && r.expiresAt < Date.now() ? " [EXPIRED]" : "";
      console.log(
        [
          r.id.padEnd(38),
          r.scope.padEnd(8),
          r.tool.padEnd(20),
          formatMatch(r.match).padEnd(40),
          formatDate(r.createdAt) + expired,
        ].join(" "),
      );
    }
  },
});

const approvalRevokeCommand = defineCommand({
  meta: { name: "revoke", description: "撤销授权记录" },
  args: {
    id: { type: "positional", description: "授权记录 ID", required: false },
    tool: { type: "string", description: "按工具名撤销所有记录", default: "" },
    all: { type: "boolean", description: "与 --tool 配合，撤销该工具的全部记录", default: false },
  },
  async run({ args }) {
    const store = getStore();
    const id = args.id as string | undefined;
    const toolName = args.tool as string;

    if (id) {
      const ok = await store.revoke(id);
      if (ok) {
        console.log(`已撤销授权记录：${id}`);
      } else {
        console.error(`未找到授权记录：${id}`);
        process.exit(1);
      }
      return;
    }

    if (toolName && args.all) {
      const count = await store.clear({ tool: toolName });
      console.log(`已撤销工具 "${toolName}" 的 ${count} 条授权记录`);
      return;
    }

    console.error("用法：approval revoke <id> 或 --tool <name> --all");
    process.exit(1);
  },
});

const approvalClearCommand = defineCommand({
  meta: { name: "clear", description: "批量清空授权记录" },
  args: {
    expired: { type: "boolean", description: "只清除已过期的记录", default: false },
    scope: { type: "string", description: "按 scope 过滤 (project|user)", default: "" },
    tool: { type: "string", description: "按工具名过滤", default: "" },
  },
  async run({ args }) {
    const store = getStore();
    const scopeArg = args.scope as string;
    const scope =
      scopeArg === "project" || scopeArg === "user" ? scopeArg : undefined;
    const toolFilter = args.tool as string;
    const count = await store.clear({
      ...(scope !== undefined ? { scope } : {}),
      ...(toolFilter ? { tool: toolFilter } : {}),
      ...(args.expired ? { expiredOnly: true } : {}),
    });
    console.log(`已清除 ${count} 条授权记录`);
  },
});

const approvalPromoteCommand = defineCommand({
  meta: { name: "promote", description: "将 project 级授权记录提升为 user 级" },
  args: {
    id: { type: "positional", description: "授权记录 ID", required: true },
  },
  async run({ args }) {
    const store = getStore();
    const id = args.id as string;
    const ok = await store.promote(id);
    if (ok) {
      console.log(`已将记录 ${id} 提升为 user 级`);
    } else {
      console.error(`未找到 project 级授权记录：${id}`);
      process.exit(1);
    }
  },
});

const approvalAddCommand = defineCommand({
  meta: { name: "add", description: "手动新增授权记录" },
  args: {
    tool: { type: "string", description: "工具名", required: true },
    kind: { type: "string", description: "匹配类型 (any|shell|path)", required: true },
    pattern: { type: "string", description: "匹配 pattern（shell 或 path 类型时需要）", default: "" },
    note: { type: "string", description: "备注", default: "" },
    scope: { type: "string", description: "授权范围 (project|user)，默认 project", default: "project" },
  },
  async run({ args }) {
    const store = getStore();
    const toolName = args.tool as string;
    const kind = args.kind as string;
    const pattern = args.pattern as string;
    const note = args.note as string;
    const scopeArg = args.scope as string;

    if (!toolName) {
      console.error("错误：--tool 是必填项");
      process.exit(1);
    }

    let match: ApprovalMatchKind;
    if (kind === "any") {
      match = { kind: "any" };
    } else if (kind === "shell") {
      if (!pattern) {
        console.error("错误：kind=shell 时必须提供 --pattern");
        process.exit(1);
      }
      match = { kind: "shellCommand", pattern };
    } else if (kind === "path") {
      if (!pattern) {
        console.error("错误：kind=path 时必须提供 --pattern");
        process.exit(1);
      }
      match = { kind: "argPattern", field: "path", pattern };
    } else {
      console.error(`错误：非法 kind "${kind}"，允许：any | shell | path`);
      process.exit(1);
    }

    const scope: "project" | "user" = scopeArg === "user" ? "user" : "project";

    const record: ApprovalRecord = {
      id: randomUUID(),
      scope,
      tool: toolName,
      match,
      createdAt: Date.now(),
      ...(note ? { note } : {}),
    };

    if (scope === "user") {
      await store.appendUser(record);
    } else {
      await store.append(record);
    }

    console.log(`已添加授权记录 ${record.id}（${scope} 级，工具：${toolName}）`);
  },
});

const approvalExportCommand = defineCommand({
  meta: { name: "export", description: "导出全部授权记录为 JSON（写到 stdout）" },
  args: {},
  async run() {
    const store = getStore();
    const records = await store.list();
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  },
});

const approvalImportCommand = defineCommand({
  meta: { name: "import", description: "从 JSON 文件批量导入授权记录" },
  args: {
    file: { type: "positional", description: "JSON 文件路径", required: true },
  },
  async run({ args }) {
    const store = getStore();
    const filePath = args.file as string;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      console.error(`读取文件失败：${(err as Error).message}`);
      process.exit(1);
    }

    let records: ApprovalRecord[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("文件内容必须是 JSON 数组");
      }
      records = parsed as ApprovalRecord[];
    } catch (err) {
      console.error(`解析 JSON 失败：${(err as Error).message}`);
      process.exit(1);
    }

    let count = 0;
    for (const record of records) {
      if (record.scope === "user") {
        await store.appendUser(record);
      } else {
        await store.append(record);
      }
      count++;
    }
    console.log(`已导入 ${count} 条授权记录`);
  },
});

export const approvalCommand = defineCommand({
  meta: { name: "approval", description: "管理持久化工具授权记录" },
  subCommands: {
    list: approvalListCommand,
    revoke: approvalRevokeCommand,
    clear: approvalClearCommand,
    promote: approvalPromoteCommand,
    add: approvalAddCommand,
    export: approvalExportCommand,
    import: approvalImportCommand,
  },
});
