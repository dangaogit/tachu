import { describe, expect, test } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { VectorIndexAdapter, VectorPoint } from "./types";

describe("VectorIndexAdapter contract", () => {
 test("upsert accepts VectorPoint[] only; searchVector accepts number[] query", async () => {
    const upserted: VectorPoint[] = [];
    const adapter: VectorIndexAdapter = {
      async upsert(points) {
        upserted.push(...points);
      },
      async searchVector(query, topK) {
        expect(Array.isArray(query)).toBe(true);
        expect(typeof query[0]).toBe("number");
        expect(topK).toBe(3);
        return [{ id: "hit-1", score: 0.9, metadata: {} }];
      },
      async delete() {},
    };

    await adapter.upsert(
      [{ id: "p1", vector: [1, 0], payload: { ref: "r1" } }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.vector).toEqual([1, 0]);

    const hits = await adapter.searchVector([1, 0], 3, {}, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(hits[0]?.id).toBe("hit-1");
  });
});
