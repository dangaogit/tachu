import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionOutbox } from "./projection-outbox";
import { ProjectionWorker } from "./projection-worker";

describe("ProjectionWorker ( P5 omega)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tachu-projection-worker-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

 test("flush drains pending refs and marks them indexed", async () => {
    const outbox = new ProjectionOutbox({ dir });
    await outbox.enqueue("s1", "a", 100);
    await outbox.enqueue("s1", "b", 101);
    await outbox.enqueue("s1", "c", 102);

    const projected: Array<{ sessionId: string; refs: readonly string[] }> = [];
    const worker = new ProjectionWorker({
      outbox,
      project: async (sessionId, refs) => {
        projected.push({ sessionId, refs });
        return refs.map((ref) => ({ ref, vectorId: `vec-${ref}` }));
      },
    });

    const result = await worker.flush("s1");

    expect(result).toEqual({ sessions: 1, projected: 3, failed: 0 });
    expect(projected).toEqual([{ sessionId: "s1", refs: ["a", "b", "c"] }]);
    const records = await outbox.list("s1");
    expect(records.map((record) => record.state)).toEqual(["indexed", "indexed", "indexed"]);
    expect(records.map((record) => record.vectorId)).toEqual(["vec-a", "vec-b", "vec-c"]);
  });
});
