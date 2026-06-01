import { describe, expect, test } from "bun:test";

import { ConfigValidationError } from "../config/errors.js";
import { loadConfig } from "../config/load-config.js";
import { createSearchRegistryFromConfig } from "./registry-factory.js";

describe("createSearchRegistryFromConfig", () => {
 test("stub keeps registry empty → resolve is null", () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
    });
    expect(cfg.search.provider).toBe("stub");
    const r = createSearchRegistryFromConfig(cfg);
    expect(r.resolve(cfg)).toBeNull();
  });

 test("brave registers when API key configured", () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
      WEB_SEARCH_PROVIDER: "brave",
      WEB_SEARCH_PROVIDER_API_KEY: "test-key",
    });
    const r = createSearchRegistryFromConfig(cfg);
    const p = r.resolve(cfg);
    expect(p).not.toBeNull();
    expect(p?.id).toBe("brave");
  });

 test("tavily registers when API key configured", () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
      WEB_SEARCH_PROVIDER: "tavily",
      WEB_SEARCH_PROVIDER_API_KEY: "tvly-test",
    });
    const r = createSearchRegistryFromConfig(cfg);
    expect(r.resolve(cfg)?.id).toBe("tavily");
  });

 test("searxng registers when endpoint configured", () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
      WEB_SEARCH_PROVIDER: "searxng",
      WEB_SEARCH_PROVIDER_ENDPOINT: "https://searx.example.org",
    });
    const r = createSearchRegistryFromConfig(cfg);
    expect(r.resolve(cfg)?.id).toBe("searxng");
  });

 test("loadConfig rejects brave without API key", () => {
    expect(() =>
      loadConfig({
        WEB_FETCH_HOST: "127.0.0.1",
        WEB_FETCH_PORT: "8787",
        WEB_FETCH_TOKEN: "",
        WEB_SEARCH_PROVIDER: "brave",
      }),
    ).toThrow(ConfigValidationError);
  });

 test("loadConfig rejects searxng without endpoint", () => {
    expect(() =>
      loadConfig({
        WEB_FETCH_HOST: "127.0.0.1",
        WEB_FETCH_PORT: "8787",
        WEB_FETCH_TOKEN: "",
        WEB_SEARCH_PROVIDER: "searxng",
      }),
    ).toThrow(ConfigValidationError);
  });
});
