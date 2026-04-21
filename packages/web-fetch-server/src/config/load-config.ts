import type {
  WebFetchServerBrowser,
  WebFetchServerCache,
  WebFetchServerConcurrency,
  WebFetchServerConfig,
  WebFetchServerLimits,
  WebFetchServerObservability,
  WebFetchServerSearch,
  WebFetchServerSecurity,
  WebFetchServerTimeouts,
} from "../types/config.js";
import { ConfigValidationError } from "./errors.js";

const DOMAIN_SEGMENT = /^[a-z0-9.-]+$/;

function deepFreeze<T extends object>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Reflect.ownKeys(obj)) {
    const value = (obj as Record<PropertyKey, unknown>)[key];
    if (value !== null && typeof value === "object") {
      if (!Object.isFrozen(value)) {
        deepFreeze(value as object);
      }
    }
  }
  return obj;
}

function trimEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

function readRaw(env: Record<string, string | undefined>, key: string): string | undefined {
  return trimEnv(env[key]);
}

function parseBool(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = readRaw(env, key);
  if (raw === undefined) return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  throw new ConfigValidationError(
    key,
    `expected boolean (true/false/1/0), got ${JSON.stringify(raw)}`,
  );
}

function parseIntInRange(
  env: Record<string, string | undefined>,
  key: string,
  min: number,
  max: number,
  defaultValue: number,
): number {
  const raw = readRaw(env, key);
  if (raw === undefined) return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigValidationError(
      key,
      `expected integer, got ${JSON.stringify(env[key])}`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) {
    throw new ConfigValidationError(
      key,
      `must be between ${min} and ${max} (inclusive), got ${n}`,
    );
  }
  return n;
}

function parsePositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const raw = readRaw(env, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigValidationError(
      key,
      `expected non-negative integer, got ${JSON.stringify(env[key])}`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new ConfigValidationError(
      key,
      `must be a positive integer (>= 1), got ${n}`,
    );
  }
  return n;
}

function parseNonNegativeInt(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const raw = readRaw(env, key);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigValidationError(
      key,
      `expected non-negative integer, got ${JSON.stringify(env[key])}`,
    );
  }
  return Number.parseInt(raw, 10);
}

function parsePort(env: Record<string, string | undefined>): number {
  return parseIntInRange(env, "WEB_FETCH_PORT", 1, 65_535, 8787);
}

function parseDomainList(
  env: Record<string, string | undefined>,
  key: string,
): ReadonlySet<string> {
  const raw = readRaw(env, key);
  if (raw === undefined) return new Set();
  const parts = raw.split(",");
  const out = new Set<string>();
  for (const part of parts) {
    const segment = part.trim().toLowerCase();
    if (segment === "") continue;
    if (!DOMAIN_SEGMENT.test(segment)) {
      throw new ConfigValidationError(
        key,
        `invalid domain segment ${JSON.stringify(segment)} (expected ^[a-z0-9.-]+$)`,
      );
    }
    out.add(segment);
  }
  return out;
}

function parseUserAgentPool(
  env: Record<string, string | undefined>,
): readonly string[] {
  const raw = readRaw(env, "WEB_FETCH_UA_POOL");
  if (raw === undefined) return [];
  const parts = raw.split(",");
  const agents: string[] = [];
  for (const part of parts) {
    const ua = part.trim();
    if (ua === "") {
      throw new ConfigValidationError(
        "WEB_FETCH_UA_POOL",
        "each comma-separated entry must be non-empty after trim",
      );
    }
    agents.push(ua);
  }
  return agents;
}

function parseOtlpHeaders(
  env: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
  const raw = readRaw(env, "WEB_FETCH_OTLP_HEADERS");
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  for (const segment of raw.split(",")) {
    const piece = segment.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      throw new ConfigValidationError(
        "WEB_FETCH_OTLP_HEADERS",
        `invalid segment ${JSON.stringify(piece)} (expected k=v)`,
      );
    }
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (k === "") {
      throw new ConfigValidationError(
        "WEB_FETCH_OTLP_HEADERS",
        `empty header name in ${JSON.stringify(piece)}`,
      );
    }
    out[k] = v;
  }
  return out;
}

function parseLogLevel(
  env: Record<string, string | undefined>,
): "debug" | "info" | "warn" | "error" {
  const raw = readRaw(env, "WEB_FETCH_LOG_LEVEL") ?? "info";
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new ConfigValidationError(
    "WEB_FETCH_LOG_LEVEL",
    `must be one of debug|info|warn|error, got ${JSON.stringify(raw)}`,
  );
}

function parseLogFormat(
  env: Record<string, string | undefined>,
): "jsonl" | "pretty" {
  const raw = readRaw(env, "WEB_FETCH_LOG_FORMAT") ?? "jsonl";
  if (raw === "jsonl" || raw === "pretty") return raw;
  throw new ConfigValidationError(
    "WEB_FETCH_LOG_FORMAT",
    `must be jsonl or pretty, got ${JSON.stringify(raw)}`,
  );
}

/**
 * 从环境变量加载并校验 {@link WebFetchServerConfig}。
 * @param env 默认为 `Bun.env`
 * @see docs/adr/decisions/0003c-web-fetch-config.md
 */
export function loadConfig(
  env: Record<string, string | undefined> = Bun.env,
): WebFetchServerConfig {
  const host = readRaw(env, "WEB_FETCH_HOST") ?? "127.0.0.1";
  const port = parsePort(env);

  const tokenRaw = readRaw(env, "WEB_FETCH_TOKEN");
  const token = tokenRaw === undefined ? null : tokenRaw;

  if (token === null && host !== "127.0.0.1") {
    throw new ConfigValidationError(
      "WEB_FETCH_HOST",
      "若绑定非 localhost 必须设置 WEB_FETCH_TOKEN",
    );
  }

  const timeouts: WebFetchServerTimeouts = {
    requestMs: parseIntInRange(
      env,
      "WEB_FETCH_REQUEST_TIMEOUT_MS",
      5000,
      180_000,
      60_000,
    ),
    defaultWaitMs: parseIntInRange(
      env,
      "WEB_FETCH_DEFAULT_WAIT_TIMEOUT_MS",
      1000,
      60_000,
      15_000,
    ),
  };

  const defaultMaxBodyChars = parseIntInRange(
    env,
    "WEB_FETCH_DEFAULT_MAX_BODY_CHARS",
    1024,
    524_288,
    32_768,
  );

  const limits: WebFetchServerLimits = {
    maxBodyBytes: parseIntInRange(
      env,
      "WEB_FETCH_MAX_BODY_BYTES",
      524_288,
      104_857_600,
      10_485_760,
    ),
    maxRequestBytes: parseIntInRange(
      env,
      "WEB_FETCH_MAX_REQUEST_BYTES",
      65_536,
      5_242_880,
      1_048_576,
    ),
    defaultMaxBodyChars,
  };

  const rateLimitRpm = parseNonNegativeInt(env, "WEB_FETCH_RATE_LIMIT_RPM", 60);
  const rateLimitBurst = parsePositiveInt(env, "WEB_FETCH_RATE_LIMIT_BURST", 10);

  const concurrency: WebFetchServerConcurrency = {
    max: parsePositiveInt(env, "WEB_FETCH_MAX_CONCURRENCY", 4),
    acquireTimeoutMs: parsePositiveInt(env, "WEB_FETCH_ACQUIRE_TIMEOUT_MS", 30_000),
    rateLimitRpm,
    rateLimitBurst,
  };

  const userAgents = parseUserAgentPool(env);

  const browser: WebFetchServerBrowser = {
    enabled: parseBool(env, "WEB_FETCH_BROWSER_ENABLED", true),
    idleMs: parsePositiveInt(env, "WEB_FETCH_BROWSER_IDLE_MS", 30_000),
    recycleAfter: parsePositiveInt(env, "WEB_FETCH_BROWSER_RECYCLE_AFTER", 500),
    recycleIntervalMs: parsePositiveInt(
      env,
      "WEB_FETCH_BROWSER_RECYCLE_INTERVAL_MS",
      1_800_000,
    ),
    stealthDefault: parseBool(env, "WEB_FETCH_STEALTH", false),
    executablePath:
      readRaw(env, "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH") ?? null,
    userAgents,
    maxConcurrency: parsePositiveInt(env, "WEB_FETCH_BROWSER_MAX_CONCURRENCY", 2),
    autoUpgradeMinChars: parseIntInRange(
      env,
      "WEB_FETCH_BROWSER_AUTO_UPGRADE_MIN_CHARS",
      1,
      100_000,
      200,
    ),
  };

  const security: WebFetchServerSecurity = {
    allowedDomains: parseDomainList(env, "WEB_FETCH_ALLOWED_DOMAINS"),
    blockedDomains: parseDomainList(env, "WEB_FETCH_BLOCKED_DOMAINS"),
    allowLoopback: parseBool(env, "WEB_FETCH_ALLOW_LOOPBACK", false),
  };

  const cacheTtlMs = parseNonNegativeInt(env, "WEB_FETCH_CACHE_TTL_MS", 0);
  const cache: WebFetchServerCache = {
    ttlMs: cacheTtlMs,
    dir: readRaw(env, "WEB_FETCH_CACHE_DIR") ?? ".cache/web-fetch",
    maxEntries: parsePositiveInt(env, "WEB_FETCH_CACHE_MAX_ENTRIES", 1000),
    maxSizeMb: parsePositiveInt(env, "WEB_FETCH_CACHE_MAX_SIZE_MB", 512),
  };

  const observability: WebFetchServerObservability = {
    logLevel: parseLogLevel(env),
    logFormat: parseLogFormat(env),
    otlpEndpoint: readRaw(env, "WEB_FETCH_OTLP_ENDPOINT") ?? null,
    otlpHeaders: parseOtlpHeaders(env),
    serviceName:
      readRaw(env, "WEB_FETCH_SERVICE_NAME") ?? "tachu-web-fetch-server",
  };

  let searchProvider = readRaw(env, "WEB_SEARCH_PROVIDER") ?? "stub";
  if (searchProvider !== "stub") {
    console.warn(
      `[web-fetch-server] WEB_SEARCH_PROVIDER=${JSON.stringify(
        searchProvider,
      )} is not available before Stage 4; falling back to "stub"`,
    );
    searchProvider = "stub";
  }

  const search: WebFetchServerSearch = {
    provider: searchProvider,
    apiKey: readRaw(env, "WEB_SEARCH_PROVIDER_API_KEY") ?? null,
    endpoint: readRaw(env, "WEB_SEARCH_PROVIDER_ENDPOINT") ?? null,
    defaultMaxResults: parsePositiveInt(
      env,
      "WEB_SEARCH_DEFAULT_MAX_RESULTS",
      10,
    ),
  };

  const config: WebFetchServerConfig = {
    host,
    port,
    token,
    timeouts,
    limits,
    concurrency,
    browser,
    security,
    cache,
    observability,
    search,
  };

  return deepFreeze(config);
}
