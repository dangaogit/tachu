/**
 * 按 {@link WebFetchServerConfig} 装配 {@link SearchProviderRegistry}。
 */

import type { WebFetchServerConfig } from "../config/index.js";
import { createBraveSearchProvider } from "./providers/brave.js";
import { createSearxngSearchProvider } from "./providers/searxng.js";
import { createTavilySearchProvider } from "./providers/tavily.js";
import { SearchProviderRegistry } from "./provider.js";

/**
 * - `stub`：不注册任何实现，路由层返回 `SEARCH_PROVIDER_NOT_CONFIGURED`（503）。
 * - `brave` / `tavily`：需 `cfg.search.apiKey`（启动期 {@link loadConfig} 已校验）。
 * - `searxng`：需 `cfg.search.endpoint`（启动期已校验）。
 */
export function createSearchRegistryFromConfig(cfg: WebFetchServerConfig): SearchProviderRegistry {
  const registry = new SearchProviderRegistry();
  const id = cfg.search.provider;

  if (id === "stub") {
    return registry;
  }
  if (id === "brave") {
    registry.register(createBraveSearchProvider(cfg));
    return registry;
  }
  if (id === "searxng") {
    registry.register(createSearxngSearchProvider(cfg));
    return registry;
  }
  if (id === "tavily") {
    registry.register(createTavilySearchProvider(cfg));
    return registry;
  }

  return registry;
}
