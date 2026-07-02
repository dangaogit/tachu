import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  AnyDescriptor,
  ExecutionRoute,
  ToolDescriptor,
  ToolUseResult,
} from "../../types";
import type { EvidenceEntry } from "../../types/evidence";
import {
  mergeEvidence,
  normalizeAgentRunEvidence,
  normalizeExternalSourceRefs,
  normalizeFileWriteRecords,
  normalizeToolObservations,
  type DescriptorRegistryView,
} from "./normalize";

const baseToolDescriptor: ToolDescriptor = {
  name: "noop-tool",
  kind: "tool",
  version: "1",
  description: "",
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 1_000,
  inputSchema: {},
  execute: "noop",
};

const buildRegistry = (
  descriptors: Record<string, AnyDescriptor>,
): DescriptorRegistryView => ({
  get(kind, ref) {
    const key = `${kind}:${ref}`;
    return descriptors[key];
  },
});

describe("normalizeToolObservations", () => {
  it("maps tool observations to execution-observation evidence with tool-observation recordType", () => {
    const toolUse: ToolUseResult = {
      kind: "tool-use-result",
      status: "ready_for_output",
      steps: [],
      observations: [{ source: "tool", tool: "read-file", callId: "c1", text: "file contents" }],
    };
    const evidence = normalizeToolObservations(toolUse);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.purpose).toBe("execution-observation");
    expect(evidence[0]?.producedBy).toBe("tool-use");
    expect(evidence[0]?.recordType).toBe("tool-observation");
  });

  it("returns empty array when toolUseResult is null", () => {
    expect(normalizeToolObservations(null)).toEqual([]);
  });
});

describe("normalizeAgentRunEvidence", () => {
  it("propagates agent-run recordType by default", () => {
    const evidence = normalizeAgentRunEvidence({
      agent: "analyst",
      evidence: [
        {
          source: "agent:analyst:c1",
          content: "agent text",
          producedBy: "agent-runtime",
          purpose: "execution-observation",
        },
      ],
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.recordType).toBe("agent-run");
    expect(evidence[0]?.producedBy).toBe("agent-runtime");
  });
});

describe("normalizeFileWriteRecords (descriptor-driven file writes)", () => {
  const writeDescriptor: ToolDescriptor = {
    ...baseToolDescriptor,
    name: "write-file",
    sideEffect: "write",
  };
  const irreversibleAgent: AgentDescriptor = {
    name: "deploy-agent",
    kind: "agent",
    version: "1",
    description: "",
    sideEffect: "irreversible",
    idempotent: false,
    requiresApproval: true,
    timeout: 1_000,
    maxDepth: 1,
    instructions: "",
  };
  const plan: ExecutionRoute = {
    tasks: [
      { id: "t-write", type: "tool", ref: "write-file", input: {} },
      { id: "t-deploy", type: "agent", ref: "deploy-agent", input: {} },
      { id: "t-skip", type: "tool", ref: "write-file", input: {} },
    ],
    edges: [],
  };
  const registry = buildRegistry({
    "tool:write-file": writeDescriptor,
    "agent:deploy-agent": irreversibleAgent,
  });

  it("emits one file-write entry per executed write/irreversible descriptor and attaches matching observation text", () => {
    const toolUse: ToolUseResult = {
      kind: "tool-use-result",
      status: "ready_for_output",
      steps: [],
      observations: [
        { source: "tool", tool: "write-file", callId: "c1", text: "wrote 42 bytes" },
      ],
    };
    const evidence = normalizeFileWriteRecords({
      steps: [
        { name: "t-write", status: "completed" },
        { name: "t-deploy", status: "completed" },
        { name: "t-skip", status: "skipped" },
      ],
      plan,
      registry,
      toolUseResult: toolUse,
    });
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.recordType).toBe("file-write");
    expect(evidence[0]?.source).toBe("write-file:c1");
    expect(evidence[0]?.content).toBe("wrote 42 bytes");
    expect(evidence[1]?.recordType).toBe("file-write");
    expect(evidence[1]?.source).toBe("agent:deploy-agent:t-deploy");
  });

  it("returns empty when registry / plan missing", () => {
    expect(normalizeFileWriteRecords({ steps: [] })).toEqual([]);
    expect(
      normalizeFileWriteRecords({ steps: [], plan, registry: undefined }),
    ).toEqual([]);
  });

  it("ignores readonly descriptors (no keyword fallback)", () => {
    const evidence = normalizeFileWriteRecords({
      steps: [{ name: "t-write", status: "completed" }],
      plan: {
        tasks: [{ id: "t-write", type: "tool", ref: "patch-irrelevant", input: {} }],
        edges: [],
      },
      registry: buildRegistry({ "tool:patch-irrelevant": baseToolDescriptor }),
    });
    expect(evidence).toEqual([]);
  });
});

describe("normalizeExternalSourceRefs (descriptor-driven external sources)", () => {
  const externalTool: ToolDescriptor = {
    ...baseToolDescriptor,
    name: "web-fetch",
    dataSource: "external",
  };
  const internalTool: ToolDescriptor = {
    ...baseToolDescriptor,
    name: "read-file",
    dataSource: "internal",
  };
  const plan: ExecutionRoute = {
    tasks: [
      { id: "t-fetch", type: "tool", ref: "web-fetch", input: {} },
      { id: "t-read", type: "tool", ref: "read-file", input: {} },
    ],
    edges: [],
  };
  const registry = buildRegistry({
    "tool:web-fetch": externalTool,
    "tool:read-file": internalTool,
  });

  it("emits external-source entries only for dataSource=external descriptors", () => {
    const toolUse: ToolUseResult = {
      kind: "tool-use-result",
      status: "ready_for_output",
      steps: [],
      observations: [
        { source: "tool", tool: "web-fetch", callId: "c10", text: "https://example.com snapshot" },
        { source: "tool", tool: "read-file", callId: "c11", text: "local-file" },
      ],
    };
    const evidence = normalizeExternalSourceRefs({
      steps: [
        { name: "t-fetch", status: "completed" },
        { name: "t-read", status: "completed" },
      ],
      plan,
      registry,
      toolUseResult: toolUse,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.recordType).toBe("external-source");
    expect(evidence[0]?.purpose).toBe("claim-support");
    expect(evidence[0]?.source).toBe("web-fetch:c10");
  });
});

describe("mergeEvidence", () => {
  it("dedupes by source+producer+purpose+recordType", () => {
    const a: EvidenceEntry[] = [
      {
        source: "s1",
        content: "x",
        producedBy: "tool-use",
        purpose: "execution-observation",
        recordType: "tool-observation",
      },
    ];
    const merged = mergeEvidence(a, a);
    expect(merged).toHaveLength(1);
  });

  it("preserves distinct file-write and tool-observation entries pointing at same source", () => {
    const obs: EvidenceEntry = {
      source: "write-file:c1",
      content: "x",
      producedBy: "tool-use",
      purpose: "execution-observation",
      recordType: "tool-observation",
    };
    const write: EvidenceEntry = {
      source: "write-file:c1",
      content: "x",
      producedBy: "tool-use",
      purpose: "execution-observation",
      recordType: "file-write",
    };
    const merged = mergeEvidence([obs], [write]);
    expect(merged).toHaveLength(2);
  });
});
