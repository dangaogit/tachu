import { describe, expect, test } from "bun:test";
import { Semaphore, SemaphoreTimeoutError } from "./semaphore";

describe("Semaphore", () => {
  test("permits=2 caps concurrent holders; extra acquires wait in FIFO order", async () => {
    const sem = new Semaphore({ permits: 2 });
    const order: number[] = [];
    const releases: (() => void)[] = [];

    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats()).toEqual({ inflight: 2, waiting: 0 });

    void sem.acquire().then((rel) => {
      order.push(1);
      releases.push(rel);
    });
    void sem.acquire().then((rel) => {
      order.push(2);
      releases.push(rel);
    });

    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats().waiting).toBe(2);

    r1();
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(order).toEqual([1]);

    r2();
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(order).toEqual([1, 2]);

    for (const rel of releases) {
      rel();
    }
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
  });

  test("release wakes the next waiter without exceeding permits", async () => {
    const sem = new Semaphore({ permits: 1 });
    const a1 = await sem.acquire();
    const p2 = sem.acquire();
    let p2Release: (() => void) | undefined;
    const p2Ready = p2.then((r) => {
      p2Release = r;
    });

    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats().waiting).toBe(1);

    a1();
    await p2Ready;
    expect(sem.stats()).toEqual({ inflight: 1, waiting: 0 });
    expect(p2Release).toBeTypeOf("function");
    p2Release?.();
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
  });

  test("abort signal rejects waiting acquire with SemaphoreTimeoutError", async () => {
    const sem = new Semaphore({ permits: 1 });
    const rel = await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire(ac.signal);
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats().waiting).toBe(1);
    ac.abort(new Error("user cancel"));
    await expect(p).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    expect(sem.stats().waiting).toBe(0);
    rel();
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
  });

  test("timeout rejects with SemaphoreTimeoutError and does not leak waiters", async () => {
    const sem = new Semaphore({ permits: 1 });
    const rel = await sem.acquire();
    const p = sem.acquire(undefined, 20);
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats().waiting).toBe(1);
    await expect(p).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    expect(sem.stats().waiting).toBe(0);
    rel();
  });

  test("stats reflect inflight and waiting", async () => {
    const sem = new Semaphore({ permits: 2 });
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
    const r1 = await sem.acquire();
    expect(sem.stats()).toEqual({ inflight: 1, waiting: 0 });
    const r2 = await sem.acquire();
    expect(sem.stats()).toEqual({ inflight: 2, waiting: 0 });
    void sem.acquire();
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats()).toEqual({ inflight: 2, waiting: 1 });
    r1();
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats()).toEqual({ inflight: 2, waiting: 0 });
    r2();
    await new Promise<void>((q) => {
      setTimeout(q, 5);
    });
    expect(sem.stats()).toEqual({ inflight: 1, waiting: 0 });
  });

  test("release callback is idempotent (double release does not over-increment)", async () => {
    const sem = new Semaphore({ permits: 1 });
    const r = await sem.acquire();
    r();
    r();
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
    await sem.acquire();
    expect(sem.stats().inflight).toBe(1);
  });

  test("50 sequential acquire/release cycles complete without deadlock", async () => {
    const sem = new Semaphore({ permits: 2 });
    const run = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        const release = await sem.acquire();
        release();
      }
    };
    await Promise.all([run(), run()]);
    expect(sem.stats()).toEqual({ inflight: 0, waiting: 0 });
  });
});
