# Observability and Safety

> See also: [README](../../README.md) · [Detailed Design](../detailed-design.md)

### OpenTelemetry Integration

Every engine event maps to an OTel span, enabling full distributed tracing:

```typescript
import { OtelEmitter } from '@tachu/extensions';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }))
);
provider.register();

const engine = new Engine({
  ...config,
  // The OtelEmitter consumes EngineEvents and creates OTel spans
});
engine.useEmitter(new OtelEmitter());
```

**Events emitted for every request:**

| Event Type | When |
|-----------|------|
| `phase_enter` / `phase_exit` | Every pipeline phase |
| `llm_call_start` / `llm_call_end` | Every LLM invocation |
| `tool_call_start` / `tool_call_end` | Every Tool execution |
| `retry` | Task-level or system-level retry triggered |
| `provider_fallback` | **Reserved (v1.x+)** — event type defined; not emitted until runtime provider fallback lands |
| `budget_warning` | Budget at 80% of limit |
| `budget_exhausted` | Budget circuit-breaker activated |
| `error` | Any `EngineError` subclass |

### Safety Module

The Safety module operates in two independent layers:

**Engine baseline (non-disableable):**
- Input size enforcement (`safety.maxInputSizeBytes`)
- Recursion depth limit (`safety.maxRecursionDepth`)
- Budget circuit-breaker (terminates immediately when token/time budget is exhausted)

**Business-injectable policies** (via `SafetyModule.registerPolicy`):
- Optional prompt-injection **warnings** via `safety.promptInjectionPatterns` (regex strings in config)
- Custom policies registered on a `DefaultSafetyModule` and passed into `Engine` via `EngineDependencies.safetyModule`
- Output content compliance checks (in custom policy `check` handlers)

```typescript
import {
  Engine,
  DefaultSafetyModule,
  DefaultObservabilityEmitter,
} from '@tachu/core';

const observability = new DefaultObservabilityEmitter();
const safetyModule = new DefaultSafetyModule(config, observability);

const unregister = safetyModule.registerPolicy({
  id: 'pii',
  scope: ['safety'],
  check: async (input) => {
    if (containsPersonalData(input.content)) {
      return {
        passed: false,
        violations: [
          { policyId: 'pii', severity: 'error', message: 'PII detected in input' },
        ],
      };
    }
    return { passed: true, violations: [] };
  },
});

const engine = new Engine(config, { observability, safetyModule });
// ... on shutdown: unregister();
```

### Graceful Degradation Policy

Tachu guarantees that **every response the user sees is a usable natural-language answer** — the engine never returns a bare "failed" status or leaks internal step IDs / phase numbers / sub-flow names. Three defensive layers enforce this:

1. **Origin** — every `EngineError` ships with a `userMessage` field resolved from a built-in Chinese template table keyed by error code; `toUserFacing()` projects only `{ code, userMessage, retryable }` to the UI layer, hiding `message` / `stack` / `cause` / `context`.
2. **Aggregation** — when validation fails and no usable candidate answer is available, the `output` phase's `ensureFallbackText()` returns a **deterministic local template only** (the Output phase must not call the LLM after validation — see `packages/core/src/engine/phases/output.ts`). Friendly LLM polish belongs in the **candidate-answer** step before validation. The returned text is always **≥ 30 characters**, contains a concrete next-step hint, and is sanitized of internal terminology.
3. **Final shield** — the CLI `StreamRenderer` runs a last-pass regex filter (`sanitizeUserText`) over every user-visible string (`finalize(text|markdown)` + `error` chunks), catching any internal term that might have slipped through upstream.

The contract is enforced by `packages/core/src/engine/phases/fallback-contract.test.ts`. Any regression that leaks `task-tool-N` / `Phase N` / `direct-answer 子流程` / `capability 路由` / `Tool / Agent 描述符` to a user-facing path fails CI.

---
