import { describe, expect, test } from "bun:test";

import { verifyBearer } from "./auth";
import { ForbiddenError, UnauthorizedError } from "./errors";

function reqWithAuth(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) {
    headers.set("Authorization", value);
  }
  return new Request("http://127.0.0.1/v1/extract", { headers });
}

describe("verifyBearer", () => {
  test("expectedToken 为 null 时不校验（放行）", () => {
    expect(() => verifyBearer(reqWithAuth(null), null)).not.toThrow();
    expect(() => verifyBearer(reqWithAuth("Bearer secret"), null)).not.toThrow();
  });

  test("已配置 token 但缺少 Authorization 时抛 UnauthorizedError", () => {
    expect(() => verifyBearer(reqWithAuth(null), "secret")).toThrow(UnauthorizedError);
  });

  test("Bearer 前缀或 scheme 错误时抛 UnauthorizedError", () => {
    expect(() => verifyBearer(reqWithAuth("Basic Zm9v"), "secret")).toThrow(UnauthorizedError);
    expect(() => verifyBearer(reqWithAuth("Token secret"), "secret")).toThrow(UnauthorizedError);
  });

  test("Bearer token 与配置一致时放行", () => {
    expect(() =>
      verifyBearer(reqWithAuth("Bearer my-static-token"), "my-static-token"),
    ).not.toThrow();
  });

  test("Bearer token 与配置不一致时抛 ForbiddenError", () => {
    expect(() =>
      verifyBearer(reqWithAuth("Bearer wrong"), "expected"),
    ).toThrow(ForbiddenError);
  });

  test("仅 Bearer 无 token 片段时视为格式错误 → UnauthorizedError", () => {
    expect(() => verifyBearer(reqWithAuth("Bearer"), "x")).toThrow(UnauthorizedError);
    expect(() => verifyBearer(reqWithAuth("Bearer "), "x")).toThrow(UnauthorizedError);
  });
});
