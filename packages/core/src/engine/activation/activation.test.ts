import { describe, expect, test } from "bun:test";
import type { RuleDescriptor } from "../../types";
import { createActivation, createRuleActivationProfile } from "./index";

const rule = (overrides: Partial<RuleDescriptor> = {}): RuleDescriptor => ({
  kind: "rule",
  name: "rule-a",
  description: "rule a",
  type: "rule",
  activation: { mode: "always" },
  content: "rule a content",
  ...overrides,
});

describe("descriptor activation core", () => {
  test("rule always activates regardless of turn inputs", async () => {
    const registry = {
      list: () => [rule()],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const result = await activation.activate("rule", { registry });

    expect(result.active.map((item) => item.name)).toEqual(["rule-a"]);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        name: "rule-a",
        active: true,
        plane: "deterministic",
        source: "always",
      }),
    ]);
  });

  test("rule manual activates only when name is explicit", async () => {
    const registry = {
      list: () => [rule({ name: "manual-rule", activation: { mode: "manual" } })],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const withoutExplicit = await activation.activate("rule", { registry });
    const withExplicit = await activation.activate("rule", {
      registry,
      explicitNames: new Set(["manual-rule"]),
    });

    expect(withoutExplicit.active).toEqual([]);
    expect(withExplicit.active.map((item) => item.name)).toEqual(["manual-rule"]);
    expect(withExplicit.decisions[0]).toEqual(
      expect.objectContaining({
        active: true,
        plane: "deterministic",
        source: "manual",
      }),
    );
  });

  test("rule semantic activates only when name is in semantic active set", async () => {
    const registry = {
      list: () => [rule({ name: "semantic-rule", activation: { mode: "semantic" } })],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const withoutSemantic = await activation.activate("rule", { registry });
    const withSemantic = await activation.activate("rule", {
      registry,
      semanticActiveNames: new Set(["semantic-rule"]),
    });

    expect(withoutSemantic.active).toEqual([]);
    expect(withSemantic.active.map((item) => item.name)).toEqual(["semantic-rule"]);
    expect(withSemantic.decisions[0]).toEqual(
      expect.objectContaining({
        active: true,
        plane: "semantic",
        source: "semantic",
      }),
    );
  });

  test("rule path activates only when a context file matches its globs", async () => {
    const registry = {
      list: () => [
        rule({
          name: "path-rule",
          activation: { mode: "path", globs: ["src/**/*.ts"] },
        }),
      ],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const withoutMatch = await activation.activate("rule", {
      registry,
      contextFilePaths: ["docs/readme.md"],
    });
    const withMatch = await activation.activate("rule", {
      registry,
      contextFilePaths: ["src/engine/engine.ts"],
    });

    expect(withoutMatch.active).toEqual([]);
    expect(withMatch.active.map((item) => item.name)).toEqual(["path-rule"]);
    expect(withMatch.decisions[0]).toEqual(
      expect.objectContaining({
        active: true,
        plane: "deterministic",
        source: "path",
      }),
    );
  });

  test("missing runtime inputs fail closed without throwing", async () => {
    const registry = {
      list: () => [
        rule({ name: "manual-rule", activation: { mode: "manual" } }),
        rule({ name: "semantic-rule", activation: { mode: "semantic" } }),
        rule({ name: "path-rule", activation: { mode: "path", globs: ["src/**/*.ts"] } }),
      ],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const result = await activation.activate("rule", { registry });

    expect(result.active).toEqual([]);
    expect(result.decisions.map((decision) => decision.active)).toEqual([false, false, false]);
  });

  test("precedence is excludes over pins over deterministic over semantic", async () => {
    const registry = {
      list: () => [
        rule({ name: "excluded-always", activation: { mode: "always" } }),
        rule({ name: "pinned-semantic", activation: { mode: "semantic" } }),
        rule({ name: "pinned-always", activation: { mode: "always" } }),
        rule({ name: "path-with-semantic", activation: { mode: "path", globs: ["src/**/*.ts"] } }),
      ],
    };
    const activation = createActivation({
      profiles: {
        rule: createRuleActivationProfile(),
      },
    });

    const result = await activation.activate("rule", {
      registry,
      excludedNames: new Set(["excluded-always"]),
      pinnedNames: new Set(["excluded-always", "pinned-semantic", "pinned-always"]),
      semanticActiveNames: new Set(["pinned-semantic", "path-with-semantic"]),
      contextFilePaths: ["src/engine/engine.ts"],
    });

    expect(result.active.map((item) => item.name)).toEqual([
      "pinned-semantic",
      "pinned-always",
      "path-with-semantic",
    ]);
    expect(result.decisions.map((decision) => [decision.name, decision.active, decision.source])).toEqual([
      ["excluded-always", false, "exclude"],
      ["pinned-semantic", true, "pin"],
      ["pinned-always", true, "pin"],
      ["path-with-semantic", true, "path"],
    ]);
  });

  test("semantic recall errors are swallowed and recorded as degraded recall", async () => {
    const registry = {
      list: () => [rule({ name: "semantic-rule", activation: { mode: "semantic" } })],
    };
    const activation = createActivation({
      profiles: {
        rule: {
          ...createRuleActivationProfile(),
          semanticRecall: {
            recall: async () => {
              throw new Error("recall exploded");
            },
          },
        },
      },
    });

    const result = await activation.activate("rule", { registry, query: "semantic query" });

    expect(result.active).toEqual([]);
    expect(result.decisions).toHaveLength(1);
    expect(result.trace.recallDegraded?.error).toContain("recall exploded");
  });
});
