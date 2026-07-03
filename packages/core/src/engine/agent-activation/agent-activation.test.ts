import { describe, expect, test } from "bun:test";
import type { AgentDescriptor } from "../../types";
import { createActivation } from "../activation";
import { createAgentActivationProfile } from "./index";

const agent = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  kind: "agent",
  name: "researcher",
  description: "Researches code and documentation.",
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 60_000,
  maxDepth: 1,
  instructions: "Investigate and summarize findings.",
  ...overrides,
});

const registryWith = (agents: AgentDescriptor[]) => ({
  list: () => agents,
});

const activeNames = (agents: readonly AgentDescriptor[]): string[] =>
  agents.map((item) => item.name);

describe("agent activation profile", () => {
  test("all registered agents are active and dispatchable by default", async () => {
    const registry = registryWith([
      agent({ name: "researcher" }),
      agent({ name: "tester", description: "Runs focused verification." }),
    ]);
    const activation = createActivation({
      profiles: {
        agent: createAgentActivationProfile(),
      },
    });

    const result = await activation.activate("agent", { registry });

    expect(activeNames(result.active)).toEqual(["researcher", "tester"]);
    expect(result.decisions.map((decision) => [decision.name, decision.active, decision.source])).toEqual([
      ["researcher", true, "always"],
      ["tester", true, "always"],
    ]);
  });

  test("explicit agent names are active", async () => {
    const registry = registryWith([
      agent({ name: "researcher" }),
      agent({ name: "tester", description: "Runs focused verification." }),
    ]);
    const activation = createActivation({
      profiles: {
        agent: createAgentActivationProfile(),
      },
    });

    const result = await activation.activate("agent", {
      registry,
      explicitNames: new Set(["tester"]),
    });

    expect(activeNames(result.active)).toEqual(["researcher", "tester"]);
    expect(result.decisions.find((decision) => decision.name === "tester")).toEqual(
      expect.objectContaining({ active: true }),
    );
  });

  test("excluded agent names are omitted", async () => {
    const registry = registryWith([
      agent({ name: "researcher" }),
      agent({ name: "tester", description: "Runs focused verification." }),
    ]);
    const activation = createActivation({
      profiles: {
        agent: createAgentActivationProfile(),
      },
    });

    const result = await activation.activate("agent", {
      registry,
      excludedNames: new Set(["researcher"]),
    });

    expect(activeNames(result.active)).toEqual(["tester"]);
    expect(result.decisions.find((decision) => decision.name === "researcher")).toEqual(
      expect.objectContaining({ active: false, source: "exclude" }),
    );
  });

  test("semantic ranking orders agents without removing available agents", async () => {
    const registry = registryWith([
      agent({ name: "researcher", description: "Reads source code and docs." }),
      agent({ name: "tester", description: "Runs tests and verifies failures." }),
      agent({ name: "writer", description: "Drafts concise summaries." }),
    ]);
    const activation = createActivation({
      profiles: {
        agent: createAgentActivationProfile({
          semanticRecall: {
            recall: async () => [
              { name: "tester", score: 0.95, reason: "verification match" },
              { name: "writer", score: 0.35, reason: "summary match" },
            ],
          },
        }),
      },
    });

    const result = await activation.activate("agent", {
      registry,
      query: "verify the failing tests",
    });

    expect(activeNames(result.active)).toEqual(["tester", "writer", "researcher"]);
    expect(result.decisions.map((decision) => [decision.name, decision.active])).toEqual([
      ["researcher", true],
      ["tester", true],
      ["writer", true],
    ]);
  });
});
