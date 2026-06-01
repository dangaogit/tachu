import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SafetyError, TimeoutError } from "@tachu/core";

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

/**
 * 运行期安全策略开关。默认保持最严格的设置；仅集成测试临时放行 loopback。
 */
interface NetSafetyState {
  allowLoopbackForTests: boolean;
}

const netSafety: NetSafetyState = {
  allowLoopbackForTests: false,
};

/**
 * 配置网络安全开关。仅供集成测试在启动本地 HTTP 服务时临时放行 127.0.0.1 / localhost。
 *
 * 生产代码不应调用本函数。调用后请在用例结束时显式还原为 `false`，避免污染其它测试。
 */
export const configureNetSafety = (opts: {
  allowLoopbackForTests?: boolean;
}): void => {
  if (typeof opts.allowLoopbackForTests === "boolean") {
    netSafety.allowLoopbackForTests = opts.allowLoopbackForTests;
  }
};

const isPrivateIpv4 = (ip: string): boolean => {
  const [aRaw, bRaw] = ip.split(".");
  const a = Number(aRaw);
  const b = Number(bRaw);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return false;
  }
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 0) {
    return true;
  }
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === "::1") {
    return true;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  if (lower.startsWith("fe80")) {
    return true;
  }
  return false;
};

/**
 * 检查 URL 是否指向私网地址。
 *
 * @param input 待检查 URL
 * @throws SafetyError 当 URL 指向私网/本机地址时抛出
 */
export const assertPublicUrl = async (input: string): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (error) {
    throw new SafetyError("SAFETY_INVALID_URL", `URL 无效: ${input}`, { cause: error });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SafetyError("SAFETY_PROTOCOL_NOT_ALLOWED", `协议不允许: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!netSafety.allowLoopbackForTests) {
    if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
      throw new SafetyError("SAFETY_PRIVATE_NETWORK_BLOCKED", `已阻止私网地址: ${hostname}`, {
        context: { hostname },
      });
    }

    const literalIpFamily = isIP(hostname);
    if (literalIpFamily === 4 && isPrivateIpv4(hostname)) {
      throw new SafetyError("SAFETY_PRIVATE_NETWORK_BLOCKED", `已阻止私网地址: ${hostname}`, {
        context: { hostname },
      });
    }
    if (literalIpFamily === 6 && isPrivateIpv6(hostname)) {
      throw new SafetyError("SAFETY_PRIVATE_NETWORK_BLOCKED", `已阻止私网地址: ${hostname}`, {
        context: { hostname },
      });
    }

    if (literalIpFamily === 0) {
      const records = await lookup(hostname, { all: true });
      for (const record of records) {
        if (
          (record.family === 4 && isPrivateIpv4(record.address)) ||
          (record.family === 6 && isPrivateIpv6(record.address))
        ) {
          throw new SafetyError("SAFETY_PRIVATE_NETWORK_BLOCKED", `已阻止私网地址: ${hostname}`, {
            context: { hostname, resolved: records.map((item) => item.address) },
          });
        }
      }
    }
  }

  return parsed;
};

/**
 * 组合外部取消信号与超时控制。
 *
 * @param signal 外部取消信号
 * @param timeoutMs 超时时间（毫秒）
 * @param timeoutCode 超时错误码
 * @returns 合并信号与清理函数
 */
export const withAbortTimeout = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutCode = "TIMEOUT_PROVIDER_REQUEST",
): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    controller.abort(signal?.reason ?? new Error("aborted"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  timeoutId = setTimeout(() => {
    controller.abort(new TimeoutError(timeoutCode, `请求超时: ${timeoutMs}ms`, { retryable: true }));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

/**
 * 读取响应体并按最大字节数截断。
 *
 * @param response Fetch 响应
 * @param maxBytes 最大字节数
 * @returns 文本内容和截断标识
 */
export const readResponseBodyWithLimit = async (
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return { body: "", truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    const room = maxBytes - total;
    if (room <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(merged), truncated };
};
