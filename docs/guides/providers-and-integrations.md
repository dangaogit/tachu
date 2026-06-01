# Providers and Integrations

> See also: [README](../../README.md) · [Detailed Design](../detailed-design.md)

### LLM Providers

| Provider | Package | Streaming | Function Calling | Notes |
|----------|---------|-----------|-----------------|-------|
| OpenAI | `@tachu/extensions/providers` | ✅ | ✅ | GPT-4o, GPT-4o-mini, and all listable models |
| Anthropic | `@tachu/extensions/providers` | ✅ | ✅ | Claude 3.5 Sonnet and all listable models |
| Qwen | `@tachu/extensions/providers` | ✅ | ✅ | DashScope-compatible Qwen models |
| Gemini | `@tachu/extensions/providers` | ✅ | ✅ | Google Gemini via `@google/genai`. Adapter + tests ship in extensions; CLI / `@tachu/host-defaults` default assembly only auto-registers openai, anthropic, qwen, and mock — pass `GeminiProviderAdapter` in `createEngine(..., { providers: [...] })` (or extend host wiring). Listing `gemini` in `capabilityMapping` alone will fail CLI startup until the adapter is injected. |
| Mock | `@tachu/extensions/providers` | ✅ | ✅ | For testing; configurable responses |

`models.providerFallbackOrder` is a **configuration hook only** until after **`1.0.0` stable** (target **v1.x+** for runtime behavior):

- **Today:** `@tachu/host-defaults` `inferProviders()` registers every listed provider at startup (union with `capabilityMapping`); the CLI uses `[0]` as the default target when merging `--api-key` / `--api-base` overrides. Each LLM call still resolves **only** via `capabilityMapping` → `ModelRouter.resolve()`.
- **Not implemented (by design for ):** catching `ProviderError` / timeout / API errors and automatically switching to the next provider without re-planning. On failure, phases fall back to heuristics, emit warnings, or surface `ProviderError.userMessage` — they do **not** walk `providerFallbackOrder`.
- **Reserved:** `provider_fallback` observability event type and ExecutionPolicy seam are reserved for a future **v1.x+** release, not a blocker for shipping Tachu v1 `1.0.0`.

### Provider Connection Configuration

Every built-in provider accepts `apiKey`, `baseURL`, `organization` (OpenAI-only), `project` (OpenAI-only), and `timeoutMs`. Supply them at any of three levels (later wins):

1. **Environment variables** (recommended for secrets):

   | Variable | Provider | Purpose |
   |----------|----------|---------|
   | `OPENAI_API_KEY` | OpenAI | Credential fallback when `apiKey` is not set |
   | `OPENAI_BASE_URL` | OpenAI | SDK-level baseURL override (honored by `openai` SDK) |
   | `ANTHROPIC_API_KEY` | Anthropic | Credential fallback when `apiKey` is not set |
   | `ANTHROPIC_BASE_URL` | Anthropic | SDK-level baseURL override (honored by `@anthropic-ai/sdk`) |

2. **`tachu.config.ts` — `providers` block** (recommended for non-secret connection metadata):

   ```typescript
   const config: EngineConfig = {
     // ...other fields
     providers: {
       openai: {
         // apiKey stays in env; keep this file commit-safe
         baseURL: 'https://your-gateway.example.com/v1',
         organization: 'org-xxxx',
         timeoutMs: 60_000,
       },
       anthropic: {
         baseURL: 'https://your-gateway.example.com/anthropic',
         timeoutMs: 60_000,
       },
     },
   };
   ```

3. **CLI flags** (highest priority; great for one-off overrides):

   ```bash
   tachu run "..." --provider openai \
     --api-base https://gateway.example.com/v1 \
     --api-key sk-dev \
     --organization org-xxxx

   tachu chat --provider anthropic \
     --api-base https://gateway.example.com/anthropic
   ```

   Flags apply to whichever provider the request ends up using — either the one supplied via `--provider`, or the one resolved from your `capabilityMapping`. CLI flags never touch the `mock` provider.

Typical use cases: Azure OpenAI, self-hosted LiteLLM / OpenRouter / Kong gateways, organization-wide egress proxies, and air-gapped environments.

### MCP (Model Context Protocol)

Tachu ships two official adapters for MCP (`McpStdioAdapter` / `McpSseAdapter`, built on `@modelcontextprotocol/sdk`) and the CLI wires them into `DescriptorRegistry` and the `TaskExecutor`—declare an `mcpServers` block in `tachu.config.ts`, and the CLI auto-discovers tools, routes calls, and disconnects on exit.

**Declarative config (recommended; field names align with the OpenAI Agents SDK and the common MCP client convention)**

```typescript
// tachu.config.ts
const config: EngineConfig = {
  // ... other fields
  mcpServers: {
    // Local stdio process (standard MCP stdio transport)
    fs: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
      env: { ...process.env },
    },
    // Remote SSE service (standard MCP SSE transport)
    remoteKb: {
      url: 'https://mcp.example.com/sse/',
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN ?? ''}` },
      timeoutMs: 50_000,
      connectTimeoutMs: 10_000,
      // Optional tachu extensions
      // description: 'Project documentation search (example)',
      // keywords: ['docs', '文档'],
      // expandOnKeywordMatch: true,
      // allowTools: ['getStatus'],
      // denyTools: ['dangerousOp'],
      // requiresApproval: true,
      // disabled: false,
      // tags: ['example'],
    },
  },
};
```

Semantics:

- **Namespacing** — remote tools are registered as `<serverId>__<originalName>` (e.g. `remoteKb__getStatus`) so multiple servers coexist without name clashes
- **Fault isolation** — any server failing to connect / list tools only emits a single stderr warning; other servers and the main flow keep running
- **Timeouts & cancellation** — `adapter.connect()` is wrapped by `connectTimeoutMs`; `ToolExecutionContext.abortSignal` is forwarded to `adapter.executeTool({ signal })`, so Ctrl+C / budget breaches propagate through the protocol layer
- **Approval gating** — MCP tool `requiresApproval` is OR-ed with the per-server `requiresApproval` and the tool-loop global flag; the CLI's default `y/N` prompt handles it uniformly
- **Lifecycle** — `tachu run` / `tachu chat` always call `engine.dispose()` then `mounted.disconnectAll()` in a `finally` branch; disconnect failures only emit warnings
- **LLM-facing `description`** — when provided, the per-server `description` is prefixed to every tool's description as `[<serverId>: <description>] <original>`, so the planner can route more accurately even without reading the full JSON schema
- **Keyword-gated tools (prompt-size optimization)** — a server with `expandOnKeywordMatch: true` and non-empty `keywords` is *not* registered at startup. `tachu run <prompt>` and each `you>` turn in `tachu chat` evaluate the user input against each server's keywords (case-insensitive substring match; structured input is `JSON.stringify`'d first) and only register tools from servers whose keywords hit. Use this to keep dozens of niche tools out of the default prompt while still making them reachable on demand — the schema validator refuses `expandOnKeywordMatch: true` without keywords

**SDK usage (when you bypass the CLI and assemble the engine yourself)**

```typescript
import { McpSseAdapter, McpStdioAdapter } from '@tachu/extensions';

const sse = new McpSseAdapter({
  url: 'https://mcp.example.com/sse/',
  serverId: 'remoteKb',
  headers: { Authorization: 'Bearer ...' },
  defaultTimeoutMs: 50_000,
});
await sse.connect('https://mcp.example.com/sse/');
const tools = await sse.listTools();
for (const tool of tools) await engine.registry.register(tool);

const stdio = new McpStdioAdapter({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  serverId: 'fs',
});
await stdio.connect('');
```

If you want the same "one block of config, auto-wired" experience inside a custom host, reuse `@tachu/cli`'s `mountMcpServers(config.mcpServers, { cwd })` / `setupMcpServersFromConfig(config, registry, { cwd })`—they return `{ descriptors, executors, disconnectAll }` that you can feed into `createEngine({ extraToolExecutors })`.

### Vector Stores

| Adapter | Package | Use Case |
|---------|---------|----------|
| `InMemoryVectorStore` | `@tachu/core` | Development / testing; built-in, zero dependencies |
| `LocalFsVectorIndexAdapter` | `@tachu/extensions/vector` | Single-process production; file-backed persistence |
| `QdrantVectorIndexAdapter` | `@tachu/extensions/vector` | Multi-process production; full Qdrant REST API support |

```typescript
import { DescriptorRegistry } from '@tachu/core';
import { QdrantVectorIndexAdapter } from '@tachu/extensions/vector';
import { createEngine } from '@tachu/cli';

const vectorStore = new QdrantVectorIndexAdapter({
  url: 'http://localhost:6333',
  collectionName: 'tachu-descriptors',
});

const registry = new DescriptorRegistry({ vectorStore });
const engine = createEngine(config, { registry });
```

### Observability Emitters

| Emitter | Package | Output |
|---------|---------|--------|
| `OtelEmitter` | `@tachu/extensions` | OpenTelemetry spans via `@opentelemetry/api` |
| `JsonlEmitter` | `@tachu/extensions` | Append-only JSONL file |

### Execution Backends

| Backend | Package | Description |
|---------|---------|-------------|
| `TerminalBackend` | `@tachu/extensions` | Shell command execution in a sandboxed terminal |
| `FileBackend` | `@tachu/extensions` | File system read/write operations |
| `WebBackend` | `@tachu/extensions` | HTTP requests to external APIs / web resources |

---
