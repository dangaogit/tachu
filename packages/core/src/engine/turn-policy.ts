import type { InputEnvelope } from "../types/io";
import type { SessionScope } from "../types/scope";
import type { TurnPolicy } from "../types/turn-policy";

export const emptyTurnPolicy = (): TurnPolicy => ({
  excludeTools: [],
  includeTools: [],
  explicitSkills: [],
  excludeSkills: [],
  pinSkills: [],
  visualization: "",
});

const dedupeNames = (names: readonly string[] | undefined): string[] => {
  if (!names || names.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const filterKnownNames = (
  names: readonly string[],
  knownNames: ReadonlySet<string> | undefined,
): string[] => {
  if (!knownNames || knownNames.size === 0) return [...names];
  return names.filter((name) => knownNames.has(name));
};

export const readTurnPolicy = (input: InputEnvelope): TurnPolicy => {
  const policy = input.metadata?.turnPolicy;
  if (!policy) return emptyTurnPolicy();
  return {
    excludeTools: [...policy.excludeTools],
    includeTools: [...policy.includeTools],
    explicitSkills: [...policy.explicitSkills],
    excludeSkills: [...policy.excludeSkills],
    pinSkills: [...policy.pinSkills],
    visualization: policy.visualization ?? "",
  };
};

export interface NormalizeTurnPolicyOptions {
  scope?: SessionScope | undefined;
  knownToolNames?: ReadonlySet<string> | undefined;
  knownSkillNames?: ReadonlySet<string> | undefined;
 /** Pre-seeded deterministic host policy (e.g. CLI includeTools). */
  preseed?: TurnPolicy | undefined;
}

const mergeStringLists = (...lists: Array<readonly string[] | undefined>): string[] =>
  dedupeNames(lists.flatMap((list) => list ?? []));

export const normalizeTurnPolicy = (options: NormalizeTurnPolicyOptions): TurnPolicy => {
  const { scope, knownToolNames, knownSkillNames, preseed } = options;
  const explicitSkills = filterKnownNames(
    dedupeNames(scope?.explicitSkillNames),
    knownSkillNames,
  );
  const excludeTools = filterKnownNames(
    mergeStringLists(preseed?.excludeTools),
    knownToolNames,
  );
  const includeTools = filterKnownNames(
    mergeStringLists(preseed?.includeTools),
    knownToolNames,
  );
  const excludeSkills = filterKnownNames(
    mergeStringLists(preseed?.excludeSkills),
    knownSkillNames,
  );
  const pinSkills = filterKnownNames(
    mergeStringLists(preseed?.pinSkills),
    knownSkillNames,
  );
  const visualization = preseed?.visualization ?? "";

  return {
    excludeTools,
    includeTools,
    explicitSkills,
    excludeSkills,
    pinSkills,
    visualization,
  };
};

export const withTurnPolicyMetadata = (
  input: InputEnvelope,
  policy: TurnPolicy,
): InputEnvelope => ({
  ...input,
  metadata: {
    ...input.metadata,
    turnPolicy: policy,
  },
});
