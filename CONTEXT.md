# Tachu Engine

Tachu Engine coordinates agent runs, tool use, memory, retrieval, and result validation. This glossary records the project language used when discussing execution quality and retrieval boundaries.

## Language

**Evidence**:
Information produced or carried during a run that may be used as context for another actor, support for a claim, or an observation of execution. Evidence is a first-class concept and should not be treated as an arbitrary blob once it crosses module boundaries.
_Avoid_: Raw context, miscellaneous data, proof blob

**Claim**:
A user-visible assertion in a final answer about what was done, found, or concluded. A claim may require evidence before validation can allow it to be delivered as completed.
_Avoid_: Statement, sentence, output text

**Candidate Answer**:
The answer content prepared for possible delivery before Result Validation decides whether it can be shown as completed. Output rendering may deliver a validated candidate answer or a degraded fallback, but it should not invent new completed claims after validation.
_Avoid_: Output draft, final text, fallback summary

**Result Validation**:
The engine activity that decides whether the current run result can be delivered, retried, degraded, or handed off. It evaluates claims against evidence and execution state rather than relying only on task success.
_Avoid_: Pass/fail check, output cleanup

**Agent Run Stream**:
The live event stream produced while a sub-agent is running. It is a delivery channel for progress and partial text, not evidence by itself; evidence may be emitted through the stream but remains a separate concept.
_Avoid_: Streaming evidence, final answer delta

**External Source**:
A tool or agent invocation that pulls facts from outside the engine workspace (for example the public web, a remote API, or a third-party search index). Descriptor metadata marks this capability; execution can produce **Evidence** of type external-source, which may support **external-fact** claims in **Result Validation**.
_Avoid_: Web tool, network call, internet access (as claim vocabulary)

**Descriptor Recall**:
Selecting relevant skills or tools for a run by ranking registered descriptor text. When no embedding provider is configured, recall may degrade to local text overlap; durable memory projection to a vector index remains disabled until embedding is available.
_Avoid_: Vector search, semantic index (as user-facing outcome labels)

**Active Skill**:
A skill whose full instructions are pinned into the current turn's main system prompt (T0 tier). Active skills define behavioral and output-format contracts the agent must follow while executing the turn.
_Avoid_: Available skill, loaded skill, pinned descriptor (as interchangeable labels)

**Final-Answer Skill Inheritance**:
The requirement that the candidate-answer phase's final-answer writer receives the same active skill instructions that were visible to the main execution path (planning / tool-use). Skill activation alone does not satisfy delivery if this inheritance is missing at the final-answer seam.
_Avoid_: Re-activating skills, copying the whole system prompt

**Final-Answer Skill Scope**:
Which active skills are passed into final-answer synthesis. Default scope is all active skills; an experimental scope may restrict inheritance to output-format skills only (for example chart rendering contracts). Output-format skills are identified by descriptor tag `output-format`. Configured via `runtime.finalAnswerSkillScope` (`all-active` default; `output-format-only` experimental). When the experimental scope matches no active skills, the engine emits a warning rather than failing silently.
_Avoid_: Final-answer mode, skill filter flag (as domain terms)

**Turn Policy**:
Structured manifest produced in the intent phase (`IntentResult.turnPolicy`, mirrored on `InputMetadata`) with a stable operational shape: `excludeTools`, `includeTools`, `explicitSkills`, `excludeSkills`, `pinSkills`, and optional host-defined fields such as `visualization`. The intent LLM emits a subset (`excludeTools`, `includeTools`, `excludeSkills`, `pinSkills`, `visualization` only); normalization copies host explicit skills from `SessionScope.explicitSkillNames` into `explicitSkills`, dedupes names, and fills missing list fields with empty arrays. After every intent phase, `InputMetadata.turnPolicy` is always present with this shape—even when the LLM omits `turnPolicy`—so downstream phases read a fixed wire format. Tachu hard-enforces tool exclude/include via ToolActivator and skill explicit pin / exclude / intent pin via skill activation; it does not derive or interpret domain-specific tool or skill names. Non-empty `includeTools` routes planning to tool-use (same class of decision as explicit tool mention), without a separate text-to-image flag.
_Avoid_: Intent hint, soft prompt-only routing, engine-side chart/image heuristics, root-level `textToImage`, LLM-authored explicitSkills

**Explicit Skill Mention**:
A skill the user manually invoked in the current turn (for example a `/command`, `@mention`, or UI selection). Host parses it into `SessionScope.explicitSkillNames` before intent; intent normalization copies the list to `Turn Policy.explicitSkills`. The intent classifier may see these names in a read-only **User explicit selections** prompt section so it can emit complementary pin/exclude lists without contradicting user choices; enforcement still comes from scope copy, not from LLM echo. Explicit skills force T0 pin and override `excludeSkills`; they outrank intent `pinSkills`.
_Avoid_: Treating Agent snapshot skills as user explicit mention, letting the intent LLM be the source of truth for explicit skills

**Skill Turn Policy Priority**:
When resolving active skills for a turn: Explicit Skill Mention beats `excludeSkills`, which beats `pinSkills`, which beats Agent snapshot refs, always-trigger, sticky, and retrieval candidates.
_Avoid_: Flat merge without priority, letting exclude remove user explicit skills

**Skill Resource**:
A bundled file discovered under a skill's `scripts/`, `references/`, or `assets/` subdirectory (agentskills.io directory convention). The directory prefix in `path` carries the type — core never branches on a separate type field. Discovered by scanning the skill's `sourceDir` at load time, not declared by hand in frontmatter; only applies to the directory form (a `SKILL.md` file with its own directory) — a flat single-file skill (any other filename directly under `skills/`) has no `sourceDir` scan and no resources. Readable through the `read_skill_resource` tool, whose path whitelist is this discovered set.
_Avoid_: A hand-written `resources: [{path, type}]` frontmatter array, a `loadHint` field, treating resource "type" as engine-branchable state, recursing descriptor discovery into `scripts/`/`references/`/`assets/` subdirectories (their `.md` files are resources, not standalone descriptors)

**Skill Tool Pre-Approval**:
The `allowed-tools` frontmatter field on a `SkillDescriptor` (agentskills.io optional field). Enforced inside core's `tool-use` sub-flow (alongside `shellAutoApprovePatterns`), not in any host's approval UI: when a tool call matches a pattern declared by one of the current turn's Active Skills (`ctx.prebuiltPrompt.activeSkills`), the `onBeforeToolCall` approval callback is skipped entirely — approved transparently, for every host, with no host-specific wiring required. Patterns are either a bare tool name (any arguments) or `run-shell(<regex>)` (matches only `arguments.command`, same conservative no-extra-`args` rule as `shellAutoApprovePatterns`). The exemption is scoped to that turn only (only Active Skills are consulted, never the full registry) and is never written to the persistent `ApprovalStore`.
_Avoid_: Wiring this into a specific host's approval prompt, persisting skill-granted approval across turns, confusing this with the user-driven persistent `ApprovalStore` records

**Visualization Mode**:
Optional opaque field on Turn Policy, defined and interpreted by the host (for example `data-chart` vs `generated-image`). Tachu persists and emits it for observability but does not branch execution on its value.
_Avoid_: Engine-owned visualization enum, coupling visualization to built-in routing

**Resource Reference**:
An opaque descriptor for heavy or non-text turn content — image, file, video, long text, etc. — carried out-of-band from the message text. Shape: `{ kind; uri; mimeType?; size?; name? }`, where `uri` is a host-defined identifier tachu does not interpret (tachu does not name it fileId). Generalizes the former scheme-B1 image `file.uri`.
_Avoid_: fileId as a tachu domain term; inlining payloads into message text; conflating with text-to-image output

**Resource Pool**:
The out-of-band store of `Resource Reference`s for a turn, attached to `InputEnvelope` and persisted per `MemoryEntry` (same-entry, not a session-global pool). Each reference is keyed by an unguessable, non-user-controllable key that a `Reference Placeholder` token cites.
_Avoid_: A session-global mutable pool, user-controllable keys, dangling tokens pointing at evicted resources

**Reference Placeholder**:
The token left inside message text in place of a resource, e.g. `[[ref:image:7f3a9c2e]]`, carrying the resource's opaque pool key. Matching during materialization is **by key only**, never by human-readable display name, so user-typed text like `[Image #1]` can never be spoofed into materialization. Display number is assigned by core in appearance order per kind.
_Avoid_: Matching by display name, embedding guessable/sequential keys in the matched token, trusting user-supplied tokens

**Reference Materialization**:
The Provider-boundary pass (`EngineDependencies.multimodalResolver` seam) that, per downstream unit (model call / tool call / sub-task), expands a **demanded subset** of placeholders into real content: a `Provider Image Carrier` part for images, text for text-like kinds. Demand is token-level, driven by tool input contracts and the planning LLM's routing, intersected with model capability; when demand is unspecified the default is to materialize (fidelity-first). Materialized content is appended as a tail **refs block** binding each token to its content — the inline token is preserved to keep body semantics intact. Phases that consume nothing (intent) keep tokens as plain text and never materialize.

**Resource Demand Router**:
The optional host-injected hook (`EngineDependencies.resourceDemandRouter`) called before each Provider-boundary seam invocation (direct-answer / tool-use / candidate-answer). It receives the unit, prompt messages, route `{provider, model}`, the model's `supportedKinds`, and `candidateTools`, and returns a `Resource Demand Selector`. Default (no router) keeps full fidelity (`{mode:"all"}`); any narrowing is explicit host opt-in.
_Avoid_: Making demand routing reduce fidelity by default; routing without model-capability context

**Resource Demand Selector**:
The high-level demand expression a `Resource Demand Router` returns: `{mode:"all"}` | `{mode:"none"}` | `{mode:"select"; scope; kinds?; keys?; required?}`. Core expands it (`expandDemandSelector`) into the low-level key-only `ResourceDemand` before the seam, enforcing the `body-token ∩ pool ∩ demand` invariant; `scope` (current-turn / prompt / all) bounds kind→key expansion. The low-level materializer stays key-only — kind/scope intent lives only in the selector.
_Avoid_: Pushing kind/scope selectors into the low-level key-only `ResourceDemand`; materializing "all of a kind" in the pool regardless of body tokens_Avoid_: Materializing for every phase, replacing the inline token, splicing content mid-body, resolving inside Provider Adapter

**Provider Image Carrier**:
The only supported way tachu hands an image to a Provider Adapter in the current release: inline base64 inside an `image_url` data URL (`data:<mime>;base64,...`). `Reference Materialization` produces this carrier in the tail refs block; no public HTTP image links and no provider-native file-id path in v1.
_Avoid_: Passing storage URIs straight to the model, assuming the envelope arrives provider-ready

**Materialization Degradation**:
When a demanded reference cannot be materialized, the turn does not hard-fail with a protocol error. Runtime content-fetch failure (missing asset, auth denial, unsupported MIME) or capability mismatch (routed model lacks the kind's capability) yields an in-dialogue assistant **降级说明**; tachu short-circuits before the Provider call and never forwards an unmaterialized token as content. If the resource is **required** by a tool contract, that tool call fails with a retryable error instead of silently dropping content. A missing host resolver when materializable references are present is an integration defect that **fails fast** at assembly time, not via this user-facing path.
_Avoid_: Silent drop, fake empty image_url, pushing failure through a vision LLM call, hard-failing the whole turn on optional content

**Multimodal Memory Fidelity**:
Whether prior turns' resources survive in session memory so later turns can still present them. Lossy stringify breaks fidelity; `Reference Placeholder` tokens plus same-entry `Resource Pool` preserve fidelity when paired with `Reference Materialization` on each Provider-bound assembly.
_Avoid_: Assuming current-turn envelope alone fixes multi-turn fidelity

**Multimodal Memory Scope (release)**:
The token + `Resource Pool` model applies to **new sessions only** (一刀切). The engine does not lazy-rehydrate or migrate session JSONL across schema changes — neither stringify-lossy blobs nor structured `file.uri` parts; multi-turn resources require starting a new session.
_Avoid_: Promising multi-turn resources without starting a new session, or partial migration of prior session entries

## Example Dialogue

Dev: "The final answer says the file was updated. Is that a claim?"

Domain expert: "Yes. A write-completion claim must be backed by evidence from execution, not just by natural language."

Dev: "Can inherited context count as evidence?"

Domain expert: "It is evidence, but not necessarily claim support. Result Validation must distinguish contextual evidence from evidence produced by execution."

Dev: "When should we validate the answer text?"

Domain expert: "Validate the candidate answer before rendering it as completed. Rendering can format or degrade, but it must not add new completed claims."

Dev: "Can we validate the agent stream directly?"

Domain expert: "No. The stream is how observers watch the run. Validation consumes evidence and claims, even when those were reported through stream events."

Dev: "chart-output was pinned but the answer used ASCII bars. Is activation broken?"

Domain expert: "Activation worked. Final-Answer Skill Inheritance failed — the final-answer writer never saw the active skill instructions."

Dev: "Can we pass only chart-output into final-answer to save tokens?"

Domain expert: "That is a narrower Final-Answer Skill Scope. Default remains all active skills; output-format-only is an experimental scope, not the primary contract."

Dev: "User typed /chart-output but intent excluded chart-output. Which wins?"

Domain expert: "Explicit Skill Mention wins — check explicitSkills on Turn Policy. Exclude cannot remove a user explicit skill; expect a conflict warning, not silent drop."

Dev: "User asked for charts but the run called image.qwen. Was Turn Policy wrong?"

Domain expert: "Check intent output — were the right names in excludeTools and pinSkills? That is host/intent LLM responsibility. If the lists were correct but image.qwen still ran, ToolActivator exclude failed in tachu — that is an enforcement bug, not a model preference issue."
