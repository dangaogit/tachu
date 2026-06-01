import { describe, expect, it } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import { projectMemoryRefs } from "../../src/memory/projection-projector";
import { ProjectionOutbox } from "../../src/memory/projection-outbox";

describe("projectMemoryRefs ()", () => {
  it("embeds RETRIEVAL_DOCUMENT then upserts precomputed vectors", async () => {
    const upserted: Array<{ id: string; vector: number[] }> = [];
    const embedCalls: string[] = [];
    const embedding = {
 describe() {
        return { providerId: "fake", model: "embed-model", dimensions: 2 };
      },
      async embed(req: { inputs: string[]; taskType: string }) {
        embedCalls.push(req.taskType);
        return { embeddings: req.inputs.map(() => [0.5, 0.5]) };
      },
    };
    const vectorIndex = {
      async upsert(points: readonly { id: string; vector: number[] }[]) {
        for (const point of points) {
          upserted.push({ id: point.id, vector: point.vector });
        }
      },
      async searchVector() {
        return [];
      },
      async delete() {},
    };
    const outbox = new ProjectionOutbox({ dir: "/tmp/unused-projection-test" });

    const results = await projectMemoryRefs(
      {
        embedding: embedding as never,
        vectorIndex,
        loadEntry: async (_sessionId, ref) => ({
          entry: {
            id: ref,
            role: "user" as const,
            content: `content-${ref}`,
            timestamp: 1_000,
            anchored: false,
          },
          content: `content-${ref}`,
        }),
      },
      "sess-1",
      ["ref-a", "ref-b"],
      DEFAULT_ADAPTER_CALL_CONTEXT,
      new AbortController().signal,
    );

    expect(results).toHaveLength(2);
    expect(embedCalls.every((task) => task === "RETRIEVAL_DOCUMENT")).toBe(true);
    expect(upserted).toHaveLength(2);
    expect(upserted[0]?.vector).toEqual([0.5, 0.5]);
    void outbox;
  });
});
