import { describe, expect, test } from "bun:test";
import {
  DomainNotAllowedError,
  InvalidUrlError,
  SsrfBlockedError,
} from "./errors";
import { assertSafeUrl } from "./ssrf-guard";

function isTachuSafetyShaped(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SAFETY_");
}

describe("assertSafeUrl", () => {
  test("allows https to loopback when allowLocalhost is true", async () => {
    await expect(
      assertSafeUrl("https://127.0.0.1:9/path", { allowLocalhost: true }),
    ).resolves.toBeUndefined();
  });

  test("allows http to loopback when allowLocalhost is true", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:9/", { allowLocalhost: true })).resolves.toBeUndefined();
  });

  test("rejects file:// with InvalidUrlError", async () => {
    const p = assertSafeUrl("file:///etc/passwd");
    await expect(p).rejects.toBeInstanceOf(InvalidUrlError);
    try {
      await p;
    } catch (e) {
      expect(e).toMatchObject({
        code: "INVALID_URL",
        httpStatus: 400,
        detail: { url: "file:///etc/passwd" },
      });
      expect(isTachuSafetyShaped(e)).toBe(false);
    }
  });

  test("blocks 127.0.0.1 by default with SsrfBlockedError (not raw SAFETY_*)", async () => {
    const p = assertSafeUrl("http://127.0.0.1:8080/");
    await expect(p).rejects.toBeInstanceOf(SsrfBlockedError);
    try {
      await p;
    } catch (e) {
      expect(e).toMatchObject({
        code: "SSRF_BLOCKED",
        httpStatus: 403,
        detail: { hostname: "127.0.0.1", reason: "localhost" },
      });
      expect(isTachuSafetyShaped(e)).toBe(false);
    }
  });

  test("blocks 169.254.169.254 as cloud metadata", async () => {
    const p = assertSafeUrl("http://169.254.169.254/latest/meta-data/");
    await expect(p).rejects.toBeInstanceOf(SsrfBlockedError);
    try {
      await p;
    } catch (e) {
      expect(e).toMatchObject({
        code: "SSRF_BLOCKED",
        detail: { hostname: "169.254.169.254", reason: "cloud-metadata" },
      });
    }
  });

  test("blocks metadata.google.internal without surfacing SAFETY_* errors", async () => {
    const p = assertSafeUrl("http://metadata.google.internal/computeMetadata/v1/");
    await expect(p).rejects.toBeInstanceOf(SsrfBlockedError);
    try {
      await p;
    } catch (e) {
      expect(e).toMatchObject({
        code: "SSRF_BLOCKED",
        detail: { hostname: "metadata.google.internal", reason: "cloud-metadata" },
      });
      expect(isTachuSafetyShaped(e)).toBe(false);
    }
  });

  test("allowlist allows matching host (loopback + allowlist)", async () => {
    await expect(
      assertSafeUrl("http://127.0.0.1:9/a", {
        allowLocalhost: true,
        allowedDomains: ["127.0.0.1"],
      }),
    ).resolves.toBeUndefined();
  });

  test("allowlist rejects non-matching host", async () => {
    const p = assertSafeUrl("http://127.0.0.1:9/", {
      allowLocalhost: true,
      allowedDomains: ["example.com"],
    });
    await expect(p).rejects.toBeInstanceOf(DomainNotAllowedError);
    try {
      await p;
    } catch (e) {
      expect(e).toMatchObject({
        code: "DOMAIN_NOT_ALLOWED",
        httpStatus: 403,
        detail: { hostname: "127.0.0.1", reason: "not-in-allowlist" },
      });
    }
  });
});
