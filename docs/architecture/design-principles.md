# Design Principles

> See also: [README](../../README.md) · [Detailed Design](../detailed-design.md)

Tachu is built on seven core engineering principles drawn from its architecture:

1. **Dual-Plane Matching** — All four core abstractions are discovered semantically (vector similarity) but activated deterministically (scopes, whitelist, approval). Semantic discovery is advisory; execution gates are authoritative.

2. **Full-Path Safety Gating** — The minimum safety check (Phase 2) runs on *every* request path, including the fast path for simple questions. Safety is never traded for performance.

3. **Three-Strikes Retry Limit** — Both the task-level retry loop and the system-level retry loop are strictly bounded. Unlimited retry is not allowed. When limits are exhausted, the engine outputs step-level completion status rather than a generic failure.

4. **KV-Cache-Friendly Prompt Assembly** — The System Prompt is assembled in a stable order (hard rules → soft preferences → skills → tool definitions) so that the prefix remains unchanged across turns, maximizing KV cache reuse and reducing LLM cost.

5. **Last-Message-Wins Cancellation** — When a new message arrives in the same session, the current execution is cancelled via `AbortController` and the new input is processed in the existing context. This guarantees coherent context while avoiding stale work.

6. **Engine Agnostic of Business Permissions** — The engine only evaluates coarse-grained `scopes` from the execution context at the Tool gate. Fine-grained business authorization is the responsibility of Tool implementations or dedicated authorization Tools.

7. **Fail-Closed Safety Baseline** — Loop protection, budget circuit-breaking, and basic input validation are hardwired into the engine core and *cannot* be disabled by configuration. Even with a completely empty business configuration, the engine does not run unconstrained.

---
