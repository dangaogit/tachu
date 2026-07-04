import { describe, expect, test } from "bun:test";
import { DefaultObservabilityEmitter } from "../modules/observability";
import { InMemorySessionManager } from "../modules/session";
import { DescriptorRegistry } from "../registry";
import { createDefaultEngineConfig } from "../utils";
import type { Tokenizer } from "../prompt/tokenizer";
import type { AdapterCallContext } from "../types/context";
import type { SessionScope, SkillDescriptor } from "../types";
import { InMemoryStickyManager } from "./index";
import { resolveRunSkills, type ResolveRunSkillsParams } from "./run-skill-activation";

const tokenizer: Tokenizer = {
  count: (text) => text.length,
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

const adapterContext: AdapterCallContext = {
  correlation: {
    traceId: "trace-1",
    requestId: "req-1",
    sessionId: "s1",
    turnId: "turn-1",
  },
};

const buildParams = async (
  overrides: Partial<ResolveRunSkillsParams> & { scope?: SessionScope } = {},
): Promise<ResolveRunSkillsParams> => {
  const sessionManager = new InMemorySessionManager();
  await sessionManager.resolve("s1");
  await sessionManager.beginRun("s1", "r1");
  const base: ResolveRunSkillsParams = {
    config: createDefaultEngineConfig(),
    registry: new DescriptorRegistry(),
    sessionManager,
    stickyManager: new InMemoryStickyManager(),
    sessionId: "s1",
    currentInput: { content: "hello", metadata: { modality: "text", size: 5 } },
    contextWindow: { entries: [], tokenCount: 0, limit: 1000 },
    adapterContext,
    observability: new DefaultObservabilityEmitter(),
    tokenizer,
    maxContextTokens: 100_000,
    candidateStrategies: [],
    signal: AbortSignal.timeout(5_000),
  };
  return { ...base, ...overrides };
};

const listOf = (...entries: Array<{ name: string; description: string; tags?: string[] }>) =>
  async () => entries;

describe("resolveRunSkills — host skillDiscovery.list merge (L2 index)", () => {
  test("merges discovery entries into availableSkills as metadata-only (never active)", async () => {
    const params = await buildParams({
      scope: {
        skillDiscovery: {
          list: listOf({
            name: "my-chart-skill",
            description: "render charts from my shelf",
            tags: ["viz"],
          }),
        },
      },
    });
    const result = await resolveRunSkills(params);

    const merged = result.availableSkills.find((skill) => skill.name === "my-chart-skill");
    expect(merged).toBeDefined();
    expect(merged?.description).toBe("render charts from my shelf");
    expect(merged?.instructions).toBe("");
    expect(merged?.activation).toEqual({ mode: "semantic" });
    expect(merged?.tags).toEqual(["viz"]);
    // metadata-only entries must never be promoted to active
    expect(result.activeSkills.some((skill) => skill.name === "my-chart-skill")).toBe(false);
  });

  test("dedups against process registry (registry entry wins, no duplicate)", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "shared-name",
      description: "registry description",
      instructions: "registry instructions",
      activation: { mode: "semantic" },
    });
    const params = await buildParams({
      registry,
      scope: {
        skillDiscovery: {
          list: listOf({ name: "shared-name", description: "shelf description" }),
        },
      },
    });
    const result = await resolveRunSkills(params);

    const matches = [...result.activeSkills, ...result.availableSkills].filter(
      (skill) => skill.name === "shared-name",
    );
    // discovery must not add a second "shared-name"; the registry-managed one is authoritative
    expect(matches.every((skill) => skill.instructions !== "")).toBe(true);
    expect(
      result.availableSkills.filter((skill) => skill.name === "shared-name").length,
    ).toBeLessThanOrEqual(1);
  });

  test("two scopes only see their own discovery entries (per-call isolation)", async () => {
    const resultA = await resolveRunSkills(
      await buildParams({
        scope: { skillDiscovery: { list: listOf({ name: "skill-a", description: "a" }) } },
      }),
    );
    const resultB = await resolveRunSkills(
      await buildParams({
        scope: { skillDiscovery: { list: listOf({ name: "skill-b", description: "b" }) } },
      }),
    );
    expect(resultA.availableSkills.some((skill) => skill.name === "skill-a")).toBe(true);
    expect(resultA.availableSkills.some((skill) => skill.name === "skill-b")).toBe(false);
    expect(resultB.availableSkills.some((skill) => skill.name === "skill-b")).toBe(true);
    expect(resultB.availableSkills.some((skill) => skill.name === "skill-a")).toBe(false);
  });

  test("absent skillDiscovery leaves availableSkills unchanged", async () => {
    const withProvider = await resolveRunSkills(
      await buildParams({
        scope: { skillDiscovery: { list: listOf({ name: "extra", description: "e" }) } },
      }),
    );
    const withoutProvider = await resolveRunSkills(await buildParams());
    expect(withProvider.availableSkills.some((skill) => skill.name === "extra")).toBe(true);
    expect(withoutProvider.availableSkills).toEqual([]);
  });

  test("list() throwing degrades gracefully and emits a warning", async () => {
    const observability = new DefaultObservabilityEmitter();
    const warnings: string[] = [];
    observability.on("warning", (event) => {
      warnings.push(String(event.payload.reason));
    });
    const params = await buildParams({
      observability,
      scope: {
        skillDiscovery: {
          list: async () => {
            throw new Error("shelf backend down");
          },
        },
      },
    });
    const result = await resolveRunSkills(params);
    expect(result.availableSkills).toEqual([]);
    expect(warnings).toContain("skill_discovery_list_failed");
  });

  test("filters malformed discovery entries", async () => {
    const params = await buildParams({
      scope: {
        skillDiscovery: {
          list: async () =>
            [
              { name: "", description: "empty name" },
              { name: "ok", description: "valid" },
              { name: "no-desc" } as unknown as { name: string; description: string },
            ] as Array<{ name: string; description: string }>,
        },
      },
    });
    const result = await resolveRunSkills(params);
    const names = result.availableSkills.map((skill: SkillDescriptor) => skill.name);
    expect(names).toContain("ok");
    expect(names).not.toContain("");
    expect(names).not.toContain("no-desc");
  });
});

describe("resolveRunSkills — Loaded Skill Persistence (discovery sticky → cross-turn Active)", () => {
  const shelfDescriptor = (name: string, instructions: string): SkillDescriptor => ({
    kind: "skill",
    name,
    description: `${name} from host shelf`,
    instructions,
    activation: { mode: "semantic" },
  });

  const buildStickyParams = async (args: {
    stickySkills?: string[];
    registrySkills?: string[];
    scope?: SessionScope;
    observability?: DefaultObservabilityEmitter;
  }): Promise<ResolveRunSkillsParams> => {
    const sessionManager = new InMemorySessionManager();
    await sessionManager.resolve("s1");
    await sessionManager.beginRun("s1", "r1");
    const stickyManager = new InMemoryStickyManager();
    const currentTurn = await sessionManager.getCurrentTurn("s1");
    for (const name of args.stickySkills ?? []) {
      await stickyManager.mark({
        sessionId: "s1",
        skillName: name,
        source: "load_skill_tool",
        currentTurn,
      });
    }
    const registry = new DescriptorRegistry();
    for (const name of args.registrySkills ?? []) {
      await registry.register({
        kind: "skill",
        name,
        description: `${name} desc`,
        instructions: `${name} registry instructions`,
        activation: { mode: "semantic" },
      });
    }
    return {
      config: createDefaultEngineConfig(),
      registry,
      sessionManager,
      stickyManager,
      sessionId: "s1",
      currentInput: { content: "hello", metadata: { modality: "text", size: 5 } },
      contextWindow: { entries: [], tokenCount: 0, limit: 1000 },
      adapterContext,
      observability: args.observability ?? new DefaultObservabilityEmitter(),
      tokenizer,
      maxContextTokens: 100_000,
      candidateStrategies: [],
      signal: AbortSignal.timeout(5_000),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
    };
  };

  test("sticky discovery skill (outside registry) is materialized via load and becomes Active with instructions", async () => {
    const loadCalls: string[] = [];
    const params = await buildStickyParams({
      stickySkills: ["my-shelf-skill"],
      scope: {
        skillDiscovery: {
          load: async (name) => {
            loadCalls.push(name);
            return shelfDescriptor(name, "SHELF-INSTRUCTIONS-XYZ");
          },
        },
      },
    });
    const result = await resolveRunSkills(params);
    const active = result.activeSkills.find((skill) => skill.name === "my-shelf-skill");
    expect(active).toBeDefined();
    expect(active?.instructions).toBe("SHELF-INSTRUCTIONS-XYZ");
    expect(loadCalls).toEqual(["my-shelf-skill"]);
    // it is Active, not merely Available
    expect(result.availableSkills.some((skill) => skill.name === "my-shelf-skill")).toBe(false);
  });

  test("registry sticky skill resolves from the registry; discovery.load is not consulted", async () => {
    let loadCalled = false;
    const params = await buildStickyParams({
      stickySkills: ["reg-skill"],
      registrySkills: ["reg-skill"],
      scope: {
        skillDiscovery: {
          load: async (name) => {
            loadCalled = true;
            return shelfDescriptor(name, "should-not-be-used");
          },
        },
      },
    });
    const result = await resolveRunSkills(params);
    const active = result.activeSkills.find((skill) => skill.name === "reg-skill");
    expect(active?.instructions).toBe("reg-skill registry instructions");
    expect(loadCalled).toBe(false);
  });

  test("load returning null leaves the sticky skill inactive without throwing (ages out via TTL)", async () => {
    const params = await buildStickyParams({
      stickySkills: ["ghost"],
      scope: { skillDiscovery: { load: async () => null } },
    });
    const result = await resolveRunSkills(params);
    expect(result.activeSkills.some((skill) => skill.name === "ghost")).toBe(false);
  });

  test("load throwing degrades gracefully and emits a warning", async () => {
    const observability = new DefaultObservabilityEmitter();
    const warnings: string[] = [];
    observability.on("warning", (event) => {
      warnings.push(String(event.payload.reason));
    });
    const params = await buildStickyParams({
      stickySkills: ["boom"],
      observability,
      scope: {
        skillDiscovery: {
          load: async () => {
            throw new Error("provider down");
          },
        },
      },
    });
    const result = await resolveRunSkills(params);
    expect(result.activeSkills.some((skill) => skill.name === "boom")).toBe(false);
    expect(warnings).toContain("skill_discovery_load_failed");
  });

  test("without skillDiscovery.load, a sticky non-registry skill stays inactive (backward compatible)", async () => {
    const params = await buildStickyParams({ stickySkills: ["orphan"] });
    const result = await resolveRunSkills(params);
    expect(result.activeSkills.some((skill) => skill.name === "orphan")).toBe(false);
  });
});
