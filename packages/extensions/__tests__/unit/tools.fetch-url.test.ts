import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fetchUrlExecutor } from "../../src/tools/fetch-url/executor";
import { createToolContext } from "../helpers";

const originalFetch = globalThis.fetch;

describe("fetch-url executor", () => {
  beforeEach(() => {
    globalThis.fetch = mock(async () => {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches public URL", async () => {
    const result = await fetchUrlExecutor(
      { url: "https://example.com" },
      createToolContext(process.cwd()),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
    expect(result.contentType).toBe("text/plain");
    expect(result.truncated).toBe(false);
  });

  it("blocks private network URL", async () => {
    await expect(
      fetchUrlExecutor({ url: "http://127.0.0.1:8080" }, createToolContext(process.cwd())),
    ).rejects.toMatchObject({ code: "SAFETY_PRIVATE_NETWORK_BLOCKED" });
  });

  it("rejects invalid url and protocol", async () => {
    await expect(
      fetchUrlExecutor({ url: "not-a-url" }, createToolContext(process.cwd())),
    ).rejects.toMatchObject({ code: "SAFETY_INVALID_URL" });
    await expect(
      fetchUrlExecutor({ url: "ftp://example.com/file.txt" }, createToolContext(process.cwd())),
    ).rejects.toMatchObject({ code: "SAFETY_PROTOCOL_NOT_ALLOWED" });
  });

  it("truncates long plain-text body to the character cap with a visible notice", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("x".repeat(200 * 1024), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;
    const result = await fetchUrlExecutor(
      { url: "https://example.com/large" },
      createToolContext(process.cwd()),
    );
    expect(result.truncated).toBe(true);
    expect(result.contentType).toBe("text/plain");
    expect(result.body).toContain("[内容已截断");
    expect(result.body.length).toBeLessThanOrEqual(32 * 1024 + 200);
  });

  it("strips script/style/noscript/svg/comments and normalises whitespace for text/html", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        [
          "<!DOCTYPE html><html><head>",
          "  <title>Docs</title>",
          "  <style>.hidden{display:none}</style>",
          '  <script>window.__X__={a:1};alert("boom")</script>',
          "</head><body>",
          "  <!-- tracking pixel -->",
          "  <nav><a href=\"/\">Home</a></nav>",
          "  <svg><path d=\"M0 0\"/></svg>",
          "  <main><h1>Plugins</h1><p>Hello <strong>world</strong> &amp; friends.</p></main>",
          "  <noscript>Please enable JS</noscript>",
          "</body></html>",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }) as typeof fetch;
    const result = await fetchUrlExecutor(
      { url: "https://example.com/docs" },
      createToolContext(process.cwd()),
    );
    expect(result.contentType).toBe("text/html");
    expect(result.truncated).toBe(false);
    expect(result.body).not.toContain("<script");
    expect(result.body).not.toContain("display:none");
    expect(result.body).not.toContain("Please enable JS");
    expect(result.body).not.toContain("tracking pixel");
    expect(result.body).not.toContain("<path");
    expect(result.body).toContain("Plugins");
    expect(result.body).toContain("Home");
    expect(result.body).toContain("Hello world & friends.");
    expect(result.body).not.toContain("<p>");
  });

  it("passes non-html body through unchanged but still applies the character cap", async () => {
    const payload = JSON.stringify({ data: "x".repeat(60 * 1024) });
    globalThis.fetch = mock(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await fetchUrlExecutor(
      { url: "https://example.com/api" },
      createToolContext(process.cwd()),
    );
    expect(result.contentType).toBe("application/json");
    expect(result.truncated).toBe(true);
    expect(result.body).toContain("[内容已截断");
    expect(result.body.startsWith('{"data":"')).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(32 * 1024 + 200);
  });

  it("leaves short non-html bodies untouched (no truncation notice)", async () => {
    globalThis.fetch = mock(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as typeof fetch;
    const result = await fetchUrlExecutor(
      { url: "https://example.com/api" },
      createToolContext(process.cwd()),
    );
    expect(result.contentType).toBe("application/json");
    expect(result.truncated).toBe(false);
    expect(result.body).toBe('{"ok":true}');
  });
});
