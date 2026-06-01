import type {
  EngineConfig,
  EngineDependencies,
  ObservabilityEmitter,
  ProviderAdapter,
} from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions/providers";
import { assertCapabilityProvided } from "./capabilities";
import { ENGINE_INIT_CORRELATION } from "./constants";
import { inferProviders } from "./providers";
import { resolveSemanticRetrievalFacade } from "./semantic-retrieval";
import { resolveSemanticJudge } from "./resolve-semantic-judge";
import { resolveProjectionStack, type ProjectionStack } from "./resolve-projection-stack";

export interface BuildHostEngineDependenciesOptions {
 /** Override provider list (defaults to inferProviders(config)). */
  providers?: ProviderAdapter[];
  observability: ObservabilityEmitter;
 /**
 * Working directory used by adapters that persist relative paths (e.g. the
 * default LocalFs vector index at `<cwd>/.tachu/vector-index.json`).
 */
  cwd?: string;
}

export interface BuildHostEngineDependenciesResult {
 /** Subset of {@link EngineDependencies} ready to spread into `new Engine()`. */
  engineDependencies: Partial<EngineDependencies>;
 /**
 * Resolved {@link ProjectionStack} (embed runtime + vector index + bind
 * helper). Hosts plug it into {@link FsMemorySystem} alongside a
 * {@link ProjectionOutbox} to wire up projection.
 *
 * `undefined` when either the embedding runtime or the vector index cannot
 * be resolved — in that case projection is disabled and the
 * `projection.disabled` warning has already been emitted.
 */
  projectionStack: ProjectionStack | undefined;
 /** Inferred / overridden provider list, in case callers need it directly. */
  providers: ProviderAdapter[];
}

/**
 * Resolve shared host dependencies for Engine construction.
 *
 * CLI and non-CLI hosts call this for provider + semantic retrieval +
 * projection wiring. The returned `projectionStack` is independent of the
 * Engine dependency object — hosts decide whether to assemble
 * {@link FsMemorySystem} (CLI default), an in-memory `MemorySystem`, or some
 * custom durable store; whichever path they pick should plug
 * `projectionStack.bindProjectionProject` into their projector callback so
 * the {@link ProjectionWorker} can drain pending refs through the
 * embedding-runtime + vector-index stack.
 *
 * @returns {@link BuildHostEngineDependenciesResult} with the partial
 * {@link EngineDependencies} payload plus the projection stack. For
 * backwards-compatibility, the result is also iterable as `Partial<EngineDependencies>`
 * via the `engineDependencies` field.
 */
export function buildHostEngineDependencies(
  config: EngineConfig,
  options: BuildHostEngineDependenciesOptions,
): BuildHostEngineDependenciesResult {
  const { observability } = options;
  const providers = options.providers ?? inferProviders(config);

  const { facade: semanticRetrievalFacade } = resolveSemanticRetrievalFacade(
    config,
    providers,
    observability,
  );

  emitMockProviderWarnings(providers, observability);
  assertCapabilityProvided(observability, "providers", providers.length > 0, "providers");

  const semanticJudge = resolveSemanticJudge(config, providers);

  const projectionStack = resolveProjectionStack(config, providers, observability, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });

  const engineDependencies: Partial<EngineDependencies> = {
    providers,
    semanticRetrievalFacade,
    ...(semanticJudge !== undefined ? { semanticJudge } : {}),
  };

  return {
    engineDependencies,
    projectionStack,
    providers,
  };
}
export function emitMockProviderWarnings(
  providers: readonly ProviderAdapter[],
  observability: ObservabilityEmitter,
): void {
  const suppressMockWarning =
    process.env.NODE_ENV !== "production" &&
    process.env.TACHU_SUPPRESS_MOCK_WARNING === "1";
  if (suppressMockWarning) return;

  for (const provider of providers) {
    if (provider instanceof MockProviderAdapter) {
      observability.emit({
        timestamp: Date.now(),
        correlation: ENGINE_INIT_CORRELATION,
        phase: "init",
        type: "warning",
        payload: {
          status: "provider.mock.in-use",
          adapter: "MockProviderAdapter",
          reason:
            "MockProviderAdapter returns scripted responses; not safe for production traffic",
        },
      });
    }
  }
}

/**
 * MockProviderAdapter 在装配进 providers 时 emit 警告事件。
 */
