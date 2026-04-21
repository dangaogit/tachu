import { describe, expect, test } from "bun:test";
import {
  DataPointType,
  type HistogramMetricData,
  type ResourceMetrics,
  type SumMetricData,
} from "@opentelemetry/sdk-metrics";
import {
  createMetrics,
  flushMetricsForTest,
  getInMemoryReaderForTest,
  METRIC_NAMES,
  type CreateMetricsDeps,
} from "./metrics.js";

function sumForName(
  resourceMetrics: ResourceMetrics[],
  name: string,
): number {
  let total = 0;
  for (const rm of resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const md of sm.metrics) {
        if (md.descriptor.name !== name) continue;
        if (md.dataPointType !== DataPointType.SUM) continue;
        const sum = md as SumMetricData;
        for (const p of sum.dataPoints) {
          total += p.value;
        }
      }
    }
  }
  return total;
}

function histogramCountForName(
  resourceMetrics: ResourceMetrics[],
  name: string,
): number {
  for (const rm of resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const md of sm.metrics) {
        if (md.descriptor.name !== name) continue;
        if (md.dataPointType !== DataPointType.HISTOGRAM) continue;
        const h = md as HistogramMetricData;
        let c = 0;
        for (const p of h.dataPoints) {
          c += p.value.count;
        }
        return c;
      }
    }
  }
  return 0;
}

describe("createMetrics", () => {
  test("counter extract_total 递增", async () => {
    const m = createMetrics(
      { serviceName: "test-svc" },
      {
        getEnv: () => undefined,
      } satisfies CreateMetricsDeps,
    );
    m.extractTotal.add(1);
    m.extractTotal.add(2);
    await flushMetricsForTest();
    const exported = getInMemoryReaderForTest().getMetrics();
    expect(sumForName(exported, METRIC_NAMES.extractTotal)).toBe(3);
    await m.shutdown();
  });

  test("histogram extract_duration_ms 记录", async () => {
    const m = createMetrics({ serviceName: "test-svc" }, { getEnv: () => undefined });
    m.extractDurationMs.record(12.5);
    m.extractDurationMs.record(3);
    await flushMetricsForTest();
    const exported = getInMemoryReaderForTest().getMetrics();
    expect(histogramCountForName(exported, METRIC_NAMES.extractDurationMs)).toBe(2);
    await m.shutdown();
  });

  test("UpDownCounter browser_pool_inflight 正负变化", async () => {
    const m = createMetrics({ serviceName: "test-svc" }, { getEnv: () => undefined });
    m.browserPoolInflight.add(2);
    m.browserPoolInflight.add(-1);
    await flushMetricsForTest();
    const exported = getInMemoryReaderForTest().getMetrics();
    expect(sumForName(exported, METRIC_NAMES.browserPoolInflight)).toBe(1);
    await m.shutdown();
  });

  test("shutdown 后释放测试句柄", async () => {
    const m = createMetrics({ serviceName: "test-svc" }, { getEnv: () => undefined });
    await m.shutdown();
    expect(() => getInMemoryReaderForTest()).toThrow(/createMetrics first/);
  });

  test("未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时不报错", () => {
    const m = createMetrics(
      { serviceName: "test-svc" },
      {
        getEnv: (k) => (k === "OTEL_EXPORTER_OTLP_ENDPOINT" ? undefined : undefined),
      },
    );
    expect(m.extractTotal).toBeDefined();
    expect(m.extractDurationMs).toBeDefined();
    expect(m.browserPoolInflight).toBeDefined();
    return m.shutdown();
  });

  test("配置 OTEL_EXPORTER_OTLP_ENDPOINT 时 createMetrics 不抛错（不发起真实导出校验）", () => {
    const m = createMetrics(
      { serviceName: "test-svc" },
      {
        getEnv: (k) =>
          k === "OTEL_EXPORTER_OTLP_ENDPOINT" ? "http://127.0.0.1:9" : undefined,
      },
    );
    expect(m.extractTotal).toBeDefined();
    return m.shutdown();
  });
});
