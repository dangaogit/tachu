/**
 * OpenTelemetry trace 工厂：{@link NodeTracerProvider} + {@link BatchSpanProcessor}。
 * 未配置 OTLP 端点时使用 {@link InMemorySpanExporter}；配置后通过 OTLP/HTTP JSON 导出。
 *
 * @see docs/adr/decisions/0003c-web-fetch-config.md
 */

import type { Attributes, HrTime, SpanKind, Tracer } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { WebFetchServerConfig } from "../types/config.js";

/** 对齐 {@link import('@opentelemetry/core').ExportResultCode}，避免直接依赖 @opentelemetry/core 类型入口。 */
const EXPORT_SUCCESS = 0;
const EXPORT_FAILED = 1;

/** 与 `fetch` 兼容的最小签名（Bun 的 `fetch` 含额外静态成员，避免 `typeof fetch` 赋值失败）。 */
export type FetchLike = (
  url: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

/** 可选依赖注入（测试或自定义 fetch），禁止依赖 mock.module。 */
export type CreateTracerDeps = {
  /** 覆盖默认 span exporter（单测可注入同一 InMemory 实例以便断言）。 */
  spanExporter?: SpanExporter;
  /** OTLP HTTP 导出使用的 fetch（单测注入，避免真实网络）。 */
  fetchImpl?: FetchLike;
};

export type CreateTracerResult = {
  readonly tracer: Tracer;
  shutdown(): Promise<void>;
};

function hrTimeToNanos(t: HrTime): bigint {
  return BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
}

function hexToOtlpBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return Buffer.from(bytes).toString("base64");
}

function otlpSpanKind(kind: SpanKind): number {
  return kind + 1;
}

function otlpStatusCode(ok: boolean): number {
  return ok ? 1 : 2;
}

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

function toOtlpAnyValue(value: unknown): OtlpAnyValue {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  return { stringValue: String(value) };
}

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

function attributesToOtlp(attrs: Attributes | undefined): OtlpKeyValue[] {
  if (!attrs) {
    return [];
  }
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }
    out.push({ key, value: toOtlpAnyValue(value) });
  }
  return out;
}

function tracesExportUrl(base: string): string {
  const t = base.trim();
  if (t.endsWith("/v1/traces")) {
    return t;
  }
  return `${t.replace(/\/$/, "")}/v1/traces`;
}

/**
 * 使用 OTLP/HTTP JSON（protobuf JSON mapping）导出 trace，不引入额外 npm 包。
 */
class OtlpHttpSpanExporter implements SpanExporter {
  private readonly _url: string;
  private readonly _headers: Readonly<Record<string, string>>;
  private readonly _fetchImpl: FetchLike;
  private _stopped = false;

  constructor(
    otlpBaseUrl: string,
    extraHeaders: Readonly<Record<string, string>>,
    fetchImpl?: FetchLike,
  ) {
    this._url = tracesExportUrl(otlpBaseUrl);
    this._headers = extraHeaders;
    this._fetchImpl = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    if (this._stopped) {
      resultCallback({ code: EXPORT_FAILED });
      return;
    }
    if (spans.length === 0) {
      resultCallback({ code: EXPORT_SUCCESS });
      return;
    }

    const body = JSON.stringify(buildExportTraceServiceRequest(spans));

    const headers = new Headers({
      "Content-Type": "application/json",
    });
    for (const [k, v] of Object.entries(this._headers)) {
      headers.set(k, v);
    }

    void this._fetchImpl(this._url, {
      method: "POST",
      headers,
      body,
    })
      .then((res) => {
        if (!res.ok) {
          resultCallback({ code: EXPORT_FAILED });
          return;
        }
        resultCallback({ code: EXPORT_SUCCESS });
      })
      .catch(() => {
        resultCallback({ code: EXPORT_FAILED });
      });
  }

  async shutdown(): Promise<void> {
    this._stopped = true;
  }

  async forceFlush(): Promise<void> {
    // 无缓冲：BatchSpanProcessor 负责批处理
  }
}

type OtlpSpanJson = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number };
};

type OtlpScopeSpansJson = {
  scope: { name: string; version?: string };
  spans: OtlpSpanJson[];
};

type OtlpResourceSpansJson = {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: OtlpScopeSpansJson[];
};

function buildSpanJson(span: ReadableSpan): OtlpSpanJson {
  const ctx = span.spanContext();
  const traceId = hexToOtlpBase64(ctx.traceId);
  const spanId = hexToOtlpBase64(ctx.spanId);

  let parentSpanId: string | undefined;
  const parent = span.parentSpanContext;
  if (parent?.spanId && parent.traceId === ctx.traceId) {
    parentSpanId = hexToOtlpBase64(parent.spanId);
  }

  const ok = span.status.code !== SpanStatusCode.ERROR;

  return {
    traceId,
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name: span.name,
    kind: otlpSpanKind(span.kind),
    startTimeUnixNano: String(hrTimeToNanos(span.startTime)),
    endTimeUnixNano: String(hrTimeToNanos(span.endTime)),
    attributes: attributesToOtlp(span.attributes),
    status: { code: otlpStatusCode(ok) },
  };
}

function buildExportTraceServiceRequest(spans: ReadableSpan[]): {
  resourceSpans: OtlpResourceSpansJson[];
} {
  const byResource = new Map<string, OtlpResourceSpansJson>();

  for (const span of spans) {
    const resAttrs = attributesToOtlp(span.resource.attributes);
    const resKey = JSON.stringify(resAttrs);
    let rs = byResource.get(resKey);
    if (!rs) {
      rs = { resource: { attributes: resAttrs }, scopeSpans: [] };
      byResource.set(resKey, rs);
    }

    const scope = span.instrumentationScope;
    const scopeName = scope.name;
    const scopeVersion = scope.version;
    let scopeSpans = rs.scopeSpans.find(
      (s) => s.scope.name === scopeName && s.scope.version === scopeVersion,
    );
    if (!scopeSpans) {
      scopeSpans = {
        scope: { name: scopeName, ...(scopeVersion ? { version: scopeVersion } : {}) },
        spans: [],
      };
      rs.scopeSpans.push(scopeSpans);
    }
    scopeSpans.spans.push(buildSpanJson(span));
  }

  return { resourceSpans: [...byResource.values()] };
}

function resolveExporter(cfg: WebFetchServerConfig, deps?: CreateTracerDeps): SpanExporter {
  if (deps?.spanExporter) {
    return deps.spanExporter;
  }
  const endpoint = cfg.observability.otlpEndpoint?.trim();
  if (!endpoint) {
    return new InMemorySpanExporter();
  }
  return new OtlpHttpSpanExporter(endpoint, cfg.observability.otlpHeaders, deps?.fetchImpl);
}

/**
 * 创建与 {@link WebFetchServerConfig} 对齐的 TracerProvider，**不**调用全局 `register()`。
 *
 * @param cfg 服务端配置（使用 `observability.otlpEndpoint` / `serviceName` / headers）
 * @param deps 可选注入（单测）
 */
export function createTracer(cfg: WebFetchServerConfig, deps?: CreateTracerDeps): CreateTracerResult {
  const exporter = resolveExporter(cfg, deps);
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 1,
        scheduledDelayMillis: 0,
      }),
    ],
  });

  const tracer = provider.getTracer(cfg.observability.serviceName);

  return {
    tracer,
    async shutdown() {
      await provider.shutdown();
    },
  };
}

/**
 * 在活跃 span 内执行异步逻辑；成功标记 OK，异常标记 ERROR 并仍 {@link Span.end}。
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: () => Promise<T> | T,
  attrs?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attrs) {
      span.setAttributes(attrs);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}
