import { describe, expect, test } from "bun:test";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemorySessionManager } from "../../modules/session";
import { DescriptorRegistry } from "../../registry";
import type { AdapterCallContext, SkillDescriptor } from "../../types";
import { InMemoryStickyManager } from "../skill-activation/sticky";
import { executeInternalTool, type InternalToolContext } from "./internal-tools";

const adapterContext: AdapterCallContext = {
  correlation: {
    traceId: "trace-1",
    requestId: "req-1",
    sessionId: "s1",
    turnId: "turn-1",
  },
};

const buildCtx = async (
  overrides: Partial<InternalToolContext> = {},
): Promise<InternalToolContext> => {
  const sessionManager = new InMemorySessionManager();
  await sessionManager.resolve("s1");
  await sessionManager.beginRun("s1", "r1");
  return {
    registry: new DescriptorRegistry(),
    sessionManager,
    stickyManager: new InMemoryStickyManager(),
    observability: new DefaultObservabilityEmitter(),
    adapterContext,
    ...overrides,
  };
};

const shelfSkill = (name: string): SkillDescriptor => ({
  kind: "skill",
  name,
  description: `${name} from host shelf`,
  instructions: `full instructions for ${name}`,
  activation: { mode: "semantic" },
});

describe("executeInternalTool — host loadSkill fallback (L3)", () => {
  test("load_skill resolves via loadSkill when registry misses, returns instructions + marks sticky", async () => {
    let loadedName = "";
    const events: string[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("skill_sticky_change", (event) => {
      events.push(String(event.payload.action));
    });
    const ctx = await buildCtx({
      observability,
      loadSkill: async (name) => {
        loadedName = name;
        return shelfSkill(name);
      },
    });

    const result = await executeInternalTool("load_skill", { name: "my-shelf-skill" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.name).toBe("my-shelf-skill");
    expect(result.instructions).toBe("full instructions for my-shelf-skill");
    expect(loadedName).toBe("my-shelf-skill");
    expect(events).toContain("add");
  });

  test("load_skill prefers registry; loadSkill is not consulted on a hit", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "registered",
      description: "registry skill",
      instructions: "registry instructions",
      activation: { mode: "semantic" },
    });
    let fallbackCalled = false;
    const ctx = await buildCtx({
      registry,
      loadSkill: async (name) => {
        fallbackCalled = true;
        return shelfSkill(name);
      },
    });

    const result = await executeInternalTool("load_skill", { name: "registered" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.instructions).toBe("registry instructions");
    expect(fallbackCalled).toBe(false);
  });

  test("load_skill returns not-found when neither registry nor loadSkill resolve", async () => {
    const ctx = await buildCtx({ loadSkill: async () => null });
    const result = await executeInternalTool("load_skill", { name: "ghost" }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('skill "ghost" not found');
  });

  test("load_skill without any loadSkill wired stays not-found (backward compatible)", async () => {
    const ctx = await buildCtx();
    const result = await executeInternalTool("load_skill", { name: "ghost" }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('skill "ghost" not found');
  });

  test("read_skill_resource resolves the skill via loadSkill (whitelist enforced, not 'not found')", async () => {
    const ctx = await buildCtx({
      loadSkill: async (name) => ({
        ...shelfSkill(name),
        resources: [{ path: "references/allowed.md" }],
        sourceDir: "/tmp/does-not-matter",
      }),
    });

    // path outside the whitelist proves the skill itself was resolved (via loadSkill);
    // a failed resolution would instead report `skill "..." not found`.
    const result = await executeInternalTool(
      "read_skill_resource",
      { name: "shelf-doc", path: "references/secret.md" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("not in skill");
    expect(String(result.error)).not.toContain("not found");
  });
});
