import { timingSafeEqual } from "node:crypto";

import { ForbiddenError, UnauthorizedError } from "./errors";

const textEncoder = new TextEncoder();

/**
 * 对两段 UTF-8 字符串做恒定时间比较，避免逐字节短路比较；长度不等时仍走完整异或路径。
 *
 * `node:crypto.timingSafeEqual` 仅适用于等长缓冲区；不等长时用 O(n) 异或合并长度差。
 */
function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  if (bufA.length === bufB.length) {
    if (bufA.length === 0) {
      return true;
    }
    return timingSafeEqual(bufA, bufB);
  }
  let diff = bufA.length ^ bufB.length;
  const n = Math.max(bufA.length, bufB.length);
  for (let i = 0; i < n; i++) {
    const x = i < bufA.length ? bufA[i]! : 0;
    const y = i < bufB.length ? bufB[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * 校验 `Authorization: Bearer <token>`。未配置 token（`null`）时跳过，由配置层保证仅绑定 `127.0.0.1`。
 *
 * @param req — 入站请求
 * @param expectedToken — 配置的静态 Bearer；`null` 表示未启用鉴权
 * @throws {UnauthorizedError} 缺 header、非 Bearer 或 token 为空
 * @throws {ForbiddenError} Bearer token 与配置不一致
 */
export function verifyBearer(req: Request, expectedToken: string | null): void {
  if (expectedToken === null) {
    return;
  }

  const raw = req.headers.get("Authorization");
  if (raw === null || raw.trim() === "") {
    throw new UnauthorizedError();
  }

  const match = BEARER.exec(raw.trim());
  if (match === null) {
    throw new UnauthorizedError();
  }

  const presented = match[1]!.trim();
  if (presented === "") {
    throw new UnauthorizedError();
  }

  if (!timingSafeEqualUtf8(presented, expectedToken)) {
    throw new ForbiddenError();
  }
}
