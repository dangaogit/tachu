/**
 * CLI / 进程入口：加载配置并启动 {@link Bun.serve}。
 * @see .cursor/web-fetch-workflow/contracts/s1-c3-server-main-entry.md
 */

import { BrowserPool } from "./browser/pool.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { createTracer } from "./observability/tracer.js";
import { registerShutdown } from "./runtime/shutdown.js";
import { createServer } from "./server.js";

const cfg = loadConfig(Bun.env);

const logger = createLogger({ level: cfg.observability.logLevel }).child({
  svc: cfg.observability.serviceName,
});

logger.info("server.boot", {
  host: cfg.host,
  port: cfg.port,
  browserEnabled: cfg.browser.enabled,
  browserMaxConcurrency: cfg.browser.maxConcurrency,
  allowLoopback: cfg.security.allowLoopback,
  rateLimitRpm: cfg.concurrency.rateLimitRpm,
  tokenConfigured: cfg.token !== null,
  logLevel: cfg.observability.logLevel,
});

const pool = new BrowserPool({
  maxConcurrency: cfg.browser.maxConcurrency,
  contextIdleMs: cfg.browser.idleMs,
  executablePath: cfg.browser.executablePath,
  logger: logger.child({ component: "browser-pool" }),
});

if (cfg.browser.enabled) {
  try {
    await pool.launch();
  } catch (err) {
    logger.error("browser.pool.launch.failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

const metrics = createMetrics({ serviceName: cfg.observability.serviceName });
const tracer = createTracer(cfg);

const api = createServer(cfg, pool, { logger });

const bunServer = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch: api.fetch,
});

logger.info("server.listen", {
  host: cfg.host,
  port: bunServer.port,
  url: `http://${cfg.host}:${String(bunServer.port)}`,
  browserAvailable: pool.isAvailable(),
});

registerShutdown(
  [
    async () => {
      logger.info("server.shutdown.start");
      await api.shutdown();
      bunServer.stop();
    },
    async () => {
      await pool.close();
      logger.info("browser.pool.closed");
    },
    () => metrics.shutdown(),
    () => tracer.shutdown(),
    async () => {
      logger.info("server.shutdown.done");
    },
  ],
  {
    signals: ["SIGINT", "SIGTERM"],
    logger: console,
  },
);
