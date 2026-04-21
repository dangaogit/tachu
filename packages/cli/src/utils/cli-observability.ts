import { join } from "node:path";
import {
  DefaultObservabilityEmitter,
  type EngineConfig,
  type EngineEvent,
  type ObservabilityEmitter,
} from "@tachu/core";
import { JsonlEmitter } from "@tachu/extensions";
import { colorize } from "../renderer/color";

/**
 * CLI 侧的 Observability 装配策略。
 *
 * 与 `engine-factory` 内联的逻辑保持一致，但抽出来以便：
 * 1. run / chat 命令在装配 engine 之前就拿到 emitter 引用（便于挂 `--debug` 订阅）
 * 2. `setupMcpServersFromConfig` 与 engine 共用同一个 emitter（MCP 装配警告
 *    和引擎主干事件会落到同一份 events.jsonl，便于问题定位）
 *
 * @param config 引擎配置（只读 `observability` 子域）
 * @param cwd 宿主 cwd，用于解析 `events.jsonl` 路径
 * @returns 可观测性发射器实例
 */
export const buildCliObservability = (
  config: EngineConfig,
  cwd: string,
): ObservabilityEmitter => {
  if (config.observability.enabled) {
    const jsonlPath = join(cwd, ".tachu", "events.jsonl");
    return new JsonlEmitter({ filePath: jsonlPath });
  }
  return new DefaultObservabilityEmitter();
};

/**
 * `--debug` 打开时订阅到发射器，按事件类型友好地打印到 stderr。
 *
 * 设计要点：
 * - 不碰 stdout，避免污染 `-o json` 这类给下游程序消费的输出
 * - 按事件分类使用不同颜色：phase 边界 `blue`，llm/tool 开始 `yellow`，
 *   结束 `green`，warning / error `red`
 * - `duration_ms` / `tokenUsage` / `tool` 等关键字段优先抽出；其余 payload
 *   走受限长度的 JSON preview，避免把巨 payload 刷满终端
 * - 返回取消订阅函数，命令 finally 里调一次以防邻近测试泄漏事件监听
 *
 * @param emitter 已装配好的 ObservabilityEmitter
 * @returns 取消订阅函数；重复调用幂等
 */
export const attachCliDebugPrinter = (
  emitter: ObservabilityEmitter,
): (() => void) => {
  return emitter.on("*", (event: EngineEvent) => {
    const line = formatDebugLine(event);
    if (line) process.stderr.write(line + "\n");
  });
};

const PAYLOAD_PREVIEW_LIMIT = 240;

const formatDebugLine = (event: EngineEvent): string | null => {
  const ts = formatTimestamp(event.timestamp);
  const head = `[debug ${ts}] ${event.phase}.${event.type}`;
  const payload = event.payload ?? {};
  const detail = summarizePayload(event.type, payload);
  const color = pickColor(event.type);
  return colorize(detail ? `${head} ${detail}` : head, color);
};

const pickColor = (
  type: EngineEvent["type"],
): "gray" | "yellow" | "green" | "red" | "blue" | "cyan" => {
  if (type === "error" || type === "warning" || type.startsWith("budget")) {
    return "red";
  }
  if (type === "llm_call_start" || type === "tool_call_start" || type === "hook_fired") {
    return "yellow";
  }
  if (type === "llm_call_end" || type === "tool_call_end") {
    return "green";
  }
  if (type === "phase_enter" || type === "phase_exit") {
    return "blue";
  }
  if (type === "provider_fallback" || type === "plan_switched" || type === "retry") {
    return "cyan";
  }
  return "gray";
};

const summarizePayload = (
  type: EngineEvent["type"],
  payload: Record<string, unknown>,
): string => {
  const parts: string[] = [];
  const push = (k: string, v: unknown): void => {
    if (v === undefined || v === null || v === "") return;
    parts.push(`${k}=${stringifyShort(v)}`);
  };

  switch (type) {
    case "llm_call_start":
      push("provider", payload.provider);
      push("model", payload.model);
      push("capability", payload.capability);
      push("messages", payload.messageCount);
      break;
    case "llm_call_end":
      push("provider", payload.provider);
      push("model", payload.model);
      push("ms", payload.durationMs);
      if (payload.tokenUsage && typeof payload.tokenUsage === "object") {
        const t = payload.tokenUsage as Record<string, unknown>;
        push("in", t.input);
        push("out", t.output);
        push("total", t.total);
      }
      break;
    case "tool_call_start":
      push("tool", payload.tool);
      push("callId", payload.callId);
      push("args", payload.argumentsPreview);
      break;
    case "tool_call_end":
      push("tool", payload.tool);
      push("callId", payload.callId);
      push("ms", payload.durationMs);
      push("out", payload.outputLength);
      break;
    case "progress":
      push("stage", payload.stage);
      push("decision", payload.decision);
      push("step", payload.step);
      break;
    case "warning":
    case "error":
      push("message", payload.message);
      push("code", payload.code);
      push("serverId", payload.serverId);
      break;
    case "phase_enter":
    case "phase_exit":
      // 大多数 phase 不携带 payload；如果有则拼上。
      for (const [k, v] of Object.entries(payload)) push(k, v);
      break;
    default:
      for (const [k, v] of Object.entries(payload)) push(k, v);
      break;
  }

  if (parts.length === 0) return "";
  return parts.join(" ");
};

const stringifyShort = (value: unknown): string => {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
};

const truncate = (text: string): string =>
  text.length <= PAYLOAD_PREVIEW_LIMIT
    ? text
    : `${text.slice(0, PAYLOAD_PREVIEW_LIMIT - 1)}…`;

const formatTimestamp = (ts: number): string => {
  try {
    const d = new Date(ts);
    return d.toISOString().slice(11, 23); // HH:MM:SS.sss
  } catch {
    return String(ts);
  }
};
