/**
 * Server 运行期配置快照（与 ADR 0003c §4 / 0003b 约定对齐）。
 * @see docs/adr/decisions/0003c-web-fetch-config.md
 */

export type WebFetchServerTimeouts = {
  readonly requestMs: number;
  readonly defaultWaitMs: number;
};

export type WebFetchServerLimits = {
  readonly maxBodyBytes: number;
  readonly maxRequestBytes: number;
  readonly defaultMaxBodyChars: number;
};

export type WebFetchServerConcurrency = {
  readonly max: number;
  readonly acquireTimeoutMs: number;
  readonly rateLimitRpm: number;
  readonly rateLimitBurst: number;
};

export type WebFetchServerBrowser = {
  readonly enabled: boolean;
  readonly idleMs: number;
  readonly recycleAfter: number;
  readonly recycleIntervalMs: number;
  readonly stealthDefault: boolean;
  readonly executablePath: string | null;
  readonly userAgents: readonly string[];
  /** Max concurrent browser renders (semaphore bound); used by routes / integration tests. */
  readonly maxConcurrency: number;
  /** `renderMode: "auto"`: upgrade to browser when static body is shorter than this (chars). */
  readonly autoUpgradeMinChars: number;
};

export type WebFetchServerSecurity = {
  readonly allowedDomains: ReadonlySet<string>;
  readonly blockedDomains: ReadonlySet<string>;
  readonly allowLoopback: boolean;
};

export type WebFetchServerCache = {
  readonly ttlMs: number;
  readonly dir: string;
  readonly maxEntries: number;
  readonly maxSizeMb: number;
};

export type WebFetchServerObservability = {
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly logFormat: "jsonl" | "pretty";
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly serviceName: string;
};

export type WebFetchServerSearch = {
  readonly provider: string;
  readonly apiKey: string | null;
  readonly endpoint: string | null;
  readonly defaultMaxResults: number;
};

/**
 * `loadConfig()` 返回的只读配置对象形状。
 */
export type WebFetchServerConfig = {
  readonly host: string;
  readonly port: number;
  readonly token: string | null;

  readonly timeouts: WebFetchServerTimeouts;
  readonly limits: WebFetchServerLimits;
  readonly concurrency: WebFetchServerConcurrency;
  readonly browser: WebFetchServerBrowser;
  readonly security: WebFetchServerSecurity;
  readonly cache: WebFetchServerCache;
  readonly observability: WebFetchServerObservability;
  readonly search: WebFetchServerSearch;
};
