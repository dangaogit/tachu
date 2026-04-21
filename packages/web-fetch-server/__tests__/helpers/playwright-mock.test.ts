import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockBrowserPool } from "./playwright-mock";

const fixtureDir = join(import.meta.dir, "../fixtures");

describe("createMockBrowserPool", () => {
  test("acquire is usable and tracks inflight via stats", async () => {
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://fixture.test/": "<p>x</p>" },
    });
    expect(pool.isAvailable()).toBe(true);
    expect(pool.stats().inflight).toBe(0);

    const lease = await pool.acquire();
    expect(pool.stats().inflight).toBe(1);
    expect(pool.stats().acquireCount).toBe(1);

    await lease.release();
    expect(pool.stats().inflight).toBe(0);

    await pool.close();
  });

  test("goto serves html from htmlByUrl and content() returns it", async () => {
    const html = readFileSync(join(fixtureDir, "spa-shell.html"), "utf8");
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://spa.test/app": html },
    });
    const { context, release } = await pool.acquire();
    const page = await context.newPage();
    await page.goto("https://spa.test/app");
    expect(await page.content()).toContain('<div id="root">Loading...</div>');
    await release();
    await pool.close();
  });

  test("throwOnGoto makes goto reject", async () => {
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://example.test/": "<p>ok</p>" },
      throwOnGoto: true,
    });
    const { context, release } = await pool.acquire();
    const page = await context.newPage();
    await expect(page.goto("https://example.test/")).rejects.toThrow(/throwOnGoto/);
    await release();
    await pool.close();
  });

  test("close releases resources and rejects further acquire", async () => {
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://example.test/": "<p>ok</p>" },
    });
    const { release } = await pool.acquire();
    await release();
    await pool.close();

    expect(pool.isAvailable()).toBe(false);
    expect(pool.stats().closed).toBe(true);
    expect(pool.stats().inflight).toBe(0);

    await expect(pool.acquire()).rejects.toThrow(/pool is closed/);
  });
});
