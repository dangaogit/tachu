/**
 * SSRF 双层防护：复用 extensions `assertPublicUrl`，并叠加域名白名单与云元数据主机黑名单。
 */

import { isIP } from "node:net";
import {
  DomainNotAllowedError,
  InvalidUrlError,
  type SsrfBlockedDetail,
  SsrfBlockedError,
  type SsrfBlockedReason,
} from "./errors";

type NetGuard = {
  assertPublicUrl: (input: string) => Promise<URL>;
  configureNetSafety: (opts: { allowLoopbackForTests?: boolean }) => void;
};

const netGuardHref = new URL("../../../extensions/src/common/net.ts", import.meta.url).href;

let netGuardPromise: Promise<NetGuard> | undefined;

async function getNetGuard(): Promise<NetGuard> {
  netGuardPromise ??= import(netGuardHref).then((m) => m as NetGuard);
  return netGuardPromise;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 识别 `@tachu/core` SafetyError 形态，避免 web-fetch-server 直接依赖 core。 */
function readSafetyFields(
  err: unknown,
): { code: string; message: string; context?: Record<string, unknown> } | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const rec = err as Error & { code?: unknown; context?: unknown };
  if (typeof rec.code !== "string" || !rec.code.startsWith("SAFETY_")) {
    return undefined;
  }
  const ctx = rec.context;
  if (isRecord(ctx)) {
    return { code: rec.code, message: err.message, context: ctx };
  }
  return { code: rec.code, message: err.message };
}

const CLOUD_METADATA_HOSTS = new Set(
  [
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.azure.com",
    "instance-data.ec2.internal",
  ].map((h) => h.toLowerCase()),
);

const DEFAULT_USER_SSRF =
  "该 URL 指向内网、本机或云元数据地址，已被安全策略拦截。请仅使用公网可访问的地址。";
const DEFAULT_USER_DOMAIN =
  "当前 URL 的域名不在允许列表中。请调整域名白名单或使用被允许的站点。";
const DEFAULT_USER_INVALID = "URL 格式无效或不支持。请提供合法的 http 或 https 链接。";

export type AssertSafeUrlOptions = {
  /** 非空时，主机名必须匹配其中一项（含子域）。 */
  allowedDomains?: readonly string[] | undefined;
  /**
   * 是否允许本机 / 环回（127.0.0.1、localhost 等）。默认 `false`。
   * 实现上通过 `configureNetSafety` 临时放行 loopback，调用结束会恢复。
   */
  allowLocalhost?: boolean | undefined;
};

function parseUrlOrThrow(raw: string): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    throw new InvalidUrlError(
      `Invalid URL: ${raw}`,
      { url: raw },
      DEFAULT_USER_INVALID,
      { cause },
    );
  }
}

function ensureHttpUrl(parsed: URL, raw: string): void {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError(
      `URL must be http or https: ${parsed.protocol}`,
      { url: raw },
      DEFAULT_USER_INVALID,
    );
  }
}

function isCloudMetadataHost(hostname: string): boolean {
  return CLOUD_METADATA_HOSTS.has(hostname.toLowerCase());
}

function inferSsrfReason(hostname: string): SsrfBlockedReason {
  const lower = hostname.toLowerCase();
  if (isCloudMetadataHost(lower)) {
    return "cloud-metadata";
  }
  if (lower === "localhost" || lower.endsWith(".local") || lower.startsWith("127.")) {
    return "localhost";
  }
  const family = isIP(lower);
  if (family === 6 && (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd"))) {
    return lower === "::1" ? "localhost" : "private-ipv6";
  }
  if (family === 4) {
    const [aRaw, bRaw] = lower.split(".");
    const a = Number(aRaw);
    const b = Number(bRaw);
    if (a === 127 || lower.startsWith("127.")) {
      return "localhost";
    }
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      if (a === 169 && b === 254) {
        return "cloud-metadata";
      }
    }
    return "private-ipv4";
  }
  return "private-ipv4";
}

function buildSsrfDetailFromSafety(context: Record<string, unknown> | undefined): SsrfBlockedDetail {
  const hostname =
    typeof context?.hostname === "string" && context.hostname.length > 0
      ? context.hostname
      : "unknown";
  return {
    hostname,
    reason: inferSsrfReason(hostname),
  };
}

function hostMatchesAllowlist(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowed) {
    const entry = raw.trim().toLowerCase().replace(/\.$/u, "");
    if (entry.length === 0) {
      continue;
    }
    if (h === entry || h.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 校验 URL 是否允许由 Web Fetch Server 抓取：私网拦截、可选域名白名单、云元数据主机拦截。
 *
 * @param url 原始 URL 字符串
 * @param opts 白名单与本机放行选项
 * @throws {InvalidUrlError} 非法 URL 或非 http(s)
 * @throws {SsrfBlockedError} 私网 / 本机 / 云元数据等
 * @throws {DomainNotAllowedError} 启用白名单且不匹配
 */
export async function assertSafeUrl(url: string, opts: AssertSafeUrlOptions = {}): Promise<void> {
  const allowLocalhost = opts.allowLocalhost === true;
  const allowedDomains = opts.allowedDomains;
  const { assertPublicUrl, configureNetSafety } = await getNetGuard();

  const parsed = parseUrlOrThrow(url);
  ensureHttpUrl(parsed, url);

  const hostname = parsed.hostname.toLowerCase();

  if (isCloudMetadataHost(hostname)) {
    throw new SsrfBlockedError(
      `SSRF blocked: cloud metadata host ${hostname}`,
      { hostname, reason: "cloud-metadata" },
      DEFAULT_USER_SSRF,
    );
  }

  if (allowLocalhost) {
    configureNetSafety({ allowLoopbackForTests: true });
  }

  try {
    try {
      await assertPublicUrl(url);
    } catch (err: unknown) {
      const safety = readSafetyFields(err);
      if (safety?.code === "SAFETY_PRIVATE_NETWORK_BLOCKED") {
        const detail = buildSsrfDetailFromSafety(safety.context);
        throw new SsrfBlockedError(`SSRF blocked: ${detail.hostname}`, detail, DEFAULT_USER_SSRF, {
          cause: err,
        });
      }
      if (safety?.code === "SAFETY_INVALID_URL") {
        throw new InvalidUrlError(safety.message, { url }, DEFAULT_USER_INVALID, { cause: err });
      }
      if (safety?.code === "SAFETY_PROTOCOL_NOT_ALLOWED") {
        throw new InvalidUrlError(safety.message, { url }, DEFAULT_USER_INVALID, { cause: err });
      }
      throw err;
    }

    if (allowedDomains !== undefined && allowedDomains.length > 0) {
      if (!hostMatchesAllowlist(hostname, allowedDomains)) {
        throw new DomainNotAllowedError(
          `Domain not allowed: ${hostname}`,
          { hostname, reason: "not-in-allowlist" },
          DEFAULT_USER_DOMAIN,
        );
      }
    }
  } finally {
    if (allowLocalhost) {
      configureNetSafety({ allowLoopbackForTests: false });
    }
  }
}
