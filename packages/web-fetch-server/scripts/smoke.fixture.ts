/**
 * 本地 smoke：在 `127.0.0.1:8788` 提供与 `__tests__/fixtures/article.html` 相同的固定 HTML。
 * @see .cursor/web-fetch-workflow/contracts/s3-i10-server-smoke-check.md
 */

import path from "node:path";

const fixturePath = path.join(
  import.meta.dir,
  "..",
  "__tests__",
  "fixtures",
  "article.html",
);

const html = await Bun.file(fixturePath).text();

Bun.serve({
  hostname: "127.0.0.1",
  port: 8788,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/article") {
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.error("[smoke.fixture] listening on http://127.0.0.1:8788/article");
