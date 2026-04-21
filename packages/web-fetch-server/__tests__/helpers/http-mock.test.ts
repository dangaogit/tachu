import { describe, expect, test } from "bun:test";
import { withMockedFetch } from "./http-mock";

describe("withMockedFetch", () => {
  test("returns mocked body when URL matches a map prefix", async () => {
    await withMockedFetch(
      {
        "https://example.test/": { body: "<p>ok</p>" },
      },
      async () => {
        const res = await fetch("https://example.test/page");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<p>ok</p>");
      },
    );
  });

  test("throws when no prefix matches", async () => {
    await expect(
      withMockedFetch(
        {
          "https://other.test/": { body: "x" },
        },
        async () => {
          await fetch("https://example.test/miss");
        },
      ),
    ).rejects.toThrow(/No mock for URL/);
  });

  test("restores globalThis.fetch in finally after mocked call", async () => {
    const before = globalThis.fetch;
    await withMockedFetch(
      {
        "https://fixture.test/": { body: "hit" },
      },
      async () => {
        await fetch("https://fixture.test/a");
      },
    );
    expect(globalThis.fetch).toBe(before);
  });

  test("restores globalThis.fetch in finally after miss throws", async () => {
    const before = globalThis.fetch;
    await expect(
      withMockedFetch(
        {
          "https://only.test/": { body: "x" },
        },
        async () => {
          await fetch("https://missing.test/");
        },
      ),
    ).rejects.toThrow();
    expect(globalThis.fetch).toBe(before);
  });
});
