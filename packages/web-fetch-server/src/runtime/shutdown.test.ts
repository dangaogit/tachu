import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { registerShutdown } from "./shutdown.js";

function createTestProcess(): NodeJS.Process {
  const ee = new EventEmitter();
  const p = {
    on(event: string | symbol, listener: (...args: unknown[]) => void): NodeJS.Process {
      ee.on(event as string, listener as (...args: unknown[]) => void);
      return p as unknown as NodeJS.Process;
    },
    removeListener(
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): NodeJS.Process {
      ee.removeListener(event as string, listener as (...args: unknown[]) => void);
      return p as unknown as NodeJS.Process;
    },
    emitSignal(sig: NodeJS.Signals): void {
      ee.emit(sig, sig);
    },
  };
  return p as unknown as NodeJS.Process;
}

describe("registerShutdown", () => {
  test("invokes every handler in parallel on signal", async () => {
    const proc = createTestProcess();
    const calls: string[] = [];
    const unregister = registerShutdown(
      [
        async () => {
          calls.push("a");
        },
        async () => {
          await new Promise<void>((r) => {
            setTimeout(r, 5);
          });
          calls.push("b");
        },
      ],
      {
        signals: ["SIGTERM"],
        timeoutMs: 2_000,
        logger: { info: () => {} },
        _exitForTest: () => {},
        _processForTest: proc,
      },
    );

    (proc as unknown as { emitSignal: (s: NodeJS.Signals) => void }).emitSignal("SIGTERM");
    await new Promise<void>((r) => {
      setTimeout(r, 30);
    });

    expect(calls.sort()).toEqual(["a", "b"]);
    unregister();
  });

  test("exits with code 1 when handlers exceed timeout", async () => {
    const proc = createTestProcess();
    const exits: number[] = [];
    const logLines: string[] = [];
    registerShutdown(
      [
        () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
      ],
      {
        signals: ["SIGTERM"],
        timeoutMs: 40,
        logger: { info: (m: string) => logLines.push(m) },
        _exitForTest: (c) => exits.push(c),
        _processForTest: proc,
      },
    );

    (proc as unknown as { emitSignal: (s: NodeJS.Signals) => void }).emitSignal("SIGTERM");
    await new Promise<void>((r) => {
      setTimeout(r, 120);
    });

    expect(exits).toEqual([1]);
    expect(logLines.some((l) => l.includes("timed out"))).toBe(true);
  });

  test("unregister removes listeners so signal does not run handlers", async () => {
    const proc = createTestProcess();
    let calls = 0;
    const unregister = registerShutdown(
      [
        async () => {
          calls++;
        },
      ],
      {
        signals: ["SIGTERM"],
        timeoutMs: 500,
        logger: { info: () => {} },
        _exitForTest: () => {},
        _processForTest: proc,
      },
    );

    unregister();
    (proc as unknown as { emitSignal: (s: NodeJS.Signals) => void }).emitSignal("SIGTERM");
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });

    expect(calls).toBe(0);
  });

  test("second signal does not re-run shutdown handlers", async () => {
    const proc = createTestProcess();
    let calls = 0;
    registerShutdown(
      [
        async () => {
          calls++;
          await new Promise<void>((r) => {
            setTimeout(r, 50);
          });
        },
      ],
      {
        signals: ["SIGTERM"],
        timeoutMs: 2_000,
        logger: { info: () => {} },
        _exitForTest: () => {},
        _processForTest: proc,
      },
    );

    const emit = (proc as unknown as { emitSignal: (s: NodeJS.Signals) => void }).emitSignal.bind(
      proc,
    );
    emit("SIGTERM");
    emit("SIGTERM");

    await new Promise<void>((r) => {
      setTimeout(r, 120);
    });

    expect(calls).toBe(1);
  });
});
