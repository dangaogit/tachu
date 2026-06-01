import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionOutbox } from "./projection-outbox";

describe("ProjectionOutbox ( P5 α)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tachu-outbox-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

 test("enqueue → markRetrying → markIndexed transitions reflected in list()", async () => {
    const outbox = new ProjectionOutbox({ dir });
    await outbox.enqueue("s1", "entry-1", 100);
    await outbox.markRetrying("s1", "entry-1", 200);
    await outbox.markIndexed("s1", "entry-1", "vec-1", 300);
    const list = await outbox.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("indexed");
    expect(list[0]?.vectorId).toBe("vec-1");
  });

 test("markFailed bumps attempts; reaching maxAttempts moves to dead + DLQ file", async () => {
    const outbox = new ProjectionOutbox({ dir, maxAttempts: 2 });
    await outbox.enqueue("s2", "entry-2");
    const s1 = await outbox.markFailed("s2", "entry-2", "boom 1");
    expect(s1).toBe("failed");
    const s2 = await outbox.markFailed("s2", "entry-2", "boom 2");
    expect(s2).toBe("dead");
    const dlq = await readdir(join(dir, "dead"));
    expect(dlq.some((f) => f.startsWith("s2."))).toBe(true);
  });

 test("recover resets stale retrying back to pending after restart", async () => {
    const outbox = new ProjectionOutbox({ dir, staleAfterMs: 1_000 });
    await outbox.enqueue("s3", "entry-3", 1_000);
    await outbox.markRetrying("s3", "entry-3", 2_000);
 // Simulate process restart: drop cache, then call recover with a now that
 // is 5s beyond the retrying timestamp.
    outbox.resetCache();
    const reset = await outbox.recover("s3", 8_000);
    expect(reset).toBe(1);
    const list = await outbox.list("s3");
    expect(list[0]?.state).toBe("pending");
  });

 test("pendingCount counts pending+failed+retrying but not indexed/dead", async () => {
    const outbox = new ProjectionOutbox({ dir, maxAttempts: 2 });
    await outbox.enqueue("s4", "a");
    await outbox.enqueue("s4", "b");
    await outbox.markIndexed("s4", "a", "v");
    await outbox.markFailed("s4", "b", "e1"); // failed (attempts=1)
    expect(await outbox.pendingCount("s4")).toBe(1);
    await outbox.markFailed("s4", "b", "e2"); // dead
    expect(await outbox.pendingCount("s4")).toBe(0);
  });

 test("persists state across instances (file-backed)", async () => {
    const a = new ProjectionOutbox({ dir });
    await a.enqueue("s5", "x");
    await a.markIndexed("s5", "x", "v-x");

    const b = new ProjectionOutbox({ dir });
    const list = await b.list("s5");
    expect(list[0]?.state).toBe("indexed");
    expect(list[0]?.vectorId).toBe("v-x");

 // Verify on-disk file
    const text = await readFile(join(dir, "s5.jsonl"), "utf8");
    expect(text).toContain('"state":"indexed"');
  });

 test("enqueue is idempotent for already-indexed refs", async () => {
    const outbox = new ProjectionOutbox({ dir });
    await outbox.enqueue("s6", "r");
    await outbox.markIndexed("s6", "r", "v");
    await outbox.enqueue("s6", "r"); // should not regress to pending
    const list = await outbox.list("s6");
    expect(list[0]?.state).toBe("indexed");
  });
});
