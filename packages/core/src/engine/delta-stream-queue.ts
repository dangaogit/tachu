import type { StreamChunk } from "../types";

/**
 * 标记 direct-answer 流式 delta 结束（与 {@link StreamChunk} 分开发送）。
 */
export const DELTA_STREAM_END = Symbol("DELTA_STREAM_END");

export type DeltaStreamItem = StreamChunk | typeof DELTA_STREAM_END;

/**
 * 单生产者 / 单消费者异步队列，用于在 `runExecutionPhase` 执行期间向 `runStream` 推送 delta。
 */
export class DeltaStreamQueue {
  private items: DeltaStreamItem[] = [];
  private waiters: Array<(v: DeltaStreamItem) => void> = [];

  enqueue(item: DeltaStreamItem): void {
    const r = this.waiters.shift();
    if (r) {
      r(item);
    } else {
      this.items.push(item);
    }
  }

  async dequeue(): Promise<DeltaStreamItem> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
