/**
 * Test helper: temporarily replace `globalThis.fetch` with a URL-prefix–matched mock.
 */

export type MockFetchEntry = {
  body: string;
  status?: number;
  contentType?: string;
};

function normalizeRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function findLongestPrefixMatch(
  map: Record<string, MockFetchEntry>,
  url: string,
): MockFetchEntry | undefined {
  let bestKey = "";
  let best: MockFetchEntry | undefined;
  for (const key of Object.keys(map)) {
    if (url.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
      best = map[key];
    }
  }
  return best;
}

/**
 * Runs `fn` while `globalThis.fetch` is replaced by a mock that matches the
 * longest map key that is a prefix of the request URL. Restores the original
 * `fetch` in a `finally` block.
 */
export async function withMockedFetch(
  map: Record<string, MockFetchEntry>,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = normalizeRequestUrl(input);
    const entry = findLongestPrefixMatch(map, url);
    if (entry === undefined) {
      throw new Error(`No mock for URL: ${url}`);
    }
    const status = entry.status ?? 200;
    const contentType = entry.contentType ?? "text/html; charset=utf-8";
    return new Response(entry.body, {
      status,
      headers: { "content-type": contentType },
    });
  };

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
