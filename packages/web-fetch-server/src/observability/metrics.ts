/**
 * OpenTelemetry metrics for `@tachu/web-fetch-server`.
 *
 * OTLP 端点从环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT` 读取（与 OpenTelemetry 约定一致）；
 * 未配置时仅使用内存 exporter，不发起网络请求。
 *
 * @see docs/adr/decisions/0003c-web-fetch-config.md §2.7（可观测性）
 */

import type { Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";

/** 与契约 `createMetrics(cfg)` 对齐的最小配置。 */
export interface WebFetchMetricsConfig {
  readonly serviceName: string;
}

/**
 * 可选依赖注入（测试用）：避免 mock `process.env` 或跨文件污染。
 */
export interface CreateMetricsDeps {
  readonly getEnv?: (key: string) => string | undefined;
}

/** 与契约 §3 一致的指标 instrument 名称（ADR 可观测性语义）。 */
export const METRIC_NAMES = {
  extractTotal: "tachu.web_fetch.extract_total",
  extractDurationMs: "tachu.web_fetch.extract_duration_ms",
  browserPoolInflight: "tachu.web_fetch.browser_pool_inflight",
} as const;

const METER_NAME = "tachu.web_fetch";
const METER_VERSION = "0.1.0";

const EXPORT_INTERVAL_MS = 5_000;

let activeInMemoryExporter: InMemoryMetricExporter | undefined;
let activeMeterProvider: MeterProvider | undefined;

/**
 * 测试专用：获取与 `createMetrics` 关联的内存 exporter，便于读取 `ResourceMetrics`。
 */
export function getInMemoryReaderForTest(): InMemoryMetricExporter {
  if (!activeInMemoryExporter) {
    throw new Error("getInMemoryReaderForTest: call createMetrics first");
  }
  return activeInMemoryExporter;
}

/**
 * 将内存 reader 中的数据推送到 exporter（测试或调试前调用）。
 */
export async function flushMetricsForTest(): Promise<void> {
  if (!activeMeterProvider) {
    throw new Error("flushMetricsForTest: call createMetrics first");
  }
  await activeMeterProvider.forceFlush();
}

function readOtlpEndpoint(deps?: CreateMetricsDeps): string | undefined {
  const get = deps?.getEnv ?? ((k: string) => process.env[k]);
  const v = get("OTEL_EXPORTER_OTLP_ENDPOINT")?.trim();
  return v || undefined;
}

function readOtlpHeaders(deps?: CreateMetricsDeps): Record<string, string> {
  const get = deps?.getEnv ?? ((k: string) => process.env[k]);
  const raw = get("OTEL_EXPORTER_OTLP_HEADERS");
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function buildMetricsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  if (trimmed.endsWith("/v1/metrics")) return trimmed;
  return `${trimmed}/v1/metrics`;
}

export function createMetrics(
  cfg: WebFetchMetricsConfig,
  deps?: CreateMetricsDeps,
): {
  extractTotal: Counter;
  extractDurationMs: Histogram;
  browserPoolInflight: UpDownCounter;
  shutdown(): Promise<void>;
} {
  const resource = resourceFromAttributes({
    "service.name": cfg.serviceName,
  });

  const inMemoryExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  activeInMemoryExporter = inMemoryExporter;

  const readers: MetricReader[] = [
    new PeriodicExportingMetricReader({
      exporter: inMemoryExporter,
      exportIntervalMillis: EXPORT_INTERVAL_MS,
    }),
  ];

  const otlpEndpoint = readOtlpEndpoint(deps);
  if (otlpEndpoint) {
    const otlpExporter = new OTLPMetricExporter({
      url: buildMetricsUrl(otlpEndpoint),
      headers: readOtlpHeaders(deps),
    });
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: otlpExporter,
        exportIntervalMillis: EXPORT_INTERVAL_MS,
      }),
    );
  }

  const meterProvider = new MeterProvider({
    resource,
    readers,
  });
  activeMeterProvider = meterProvider;

  const meter = meterProvider.getMeter(METER_NAME, METER_VERSION);

  const extractTotal = meter.createCounter(METRIC_NAMES.extractTotal, {
    description: "Total completed /v1/extract pipeline runs",
  });

  const extractDurationMs = meter.createHistogram(METRIC_NAMES.extractDurationMs, {
    description: "Duration of extract pipeline in milliseconds",
    unit: "ms",
  });

  const browserPoolInflight = meter.createUpDownCounter(
    METRIC_NAMES.browserPoolInflight,
    {
      description: "In-flight browser pool acquires",
    },
  );

  return {
    extractTotal,
    extractDurationMs,
    browserPoolInflight,
    async shutdown() {
      await meterProvider.shutdown();
      activeInMemoryExporter = undefined;
      activeMeterProvider = undefined;
    },
  };
}
