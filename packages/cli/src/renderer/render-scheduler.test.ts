import { describe, expect, it } from "bun:test";
import { createRenderScheduler, throttle } from "./render-scheduler";

describe("createRenderScheduler", () => {
  it("合并短时间内的多次 schedule，只执行最后一次", async () => {
    const runs: number[] = [];
    const s = createRenderScheduler({ maxFps: 60 });
    s.schedule(() => runs.push(1));
    s.schedule(() => runs.push(2));
    s.schedule(() => runs.push(3));
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toEqual([3]);
    s.cancel();
  });

  it("cancel 后不再执行挂起的回调", async () => {
    const runs: string[] = [];
    const s = createRenderScheduler({ maxFps: 60 });
    s.schedule(() => runs.push("a"));
    s.cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toEqual([]);
  });
});

describe("throttle", () => {
  it("领先一次执行，窗口内后续合并为尾部一次", async () => {
    let n = 0;
    const t = throttle(40, () => {
      n += 1;
    });
    t();
    t();
    t();
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(2);
  });
});
