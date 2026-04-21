import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineEvent, ObservabilityEmitter } from "@tachu/core";

type EventHandler = (event: EngineEvent) => void;

interface JsonlEmitterOptions {
  filePath: string;
  rotateSize?: number;
}

/**
 * JSON Lines 文件事件发射器。
 */
export class JsonlEmitter implements ObservabilityEmitter {
  private readonly handlers = new Map<EngineEvent["type"] | "*", Set<EventHandler>>();
  private readonly filePath: string;
  private readonly rotateSize: number;
  private masker: (payload: unknown) => unknown = (payload) => payload;
  private writeQueue = Promise.resolve();

  /**
   * 创建 JSONL 发射器。
   *
   * @param options 文件配置
   */
  constructor(options: JsonlEmitterOptions) {
    this.filePath = options.filePath;
    this.rotateSize = options.rotateSize ?? 10 * 1024 * 1024;
  }

  /**
   * 订阅事件。
   *
   * @param type 事件类型
   * @param handler 处理器
   * @returns 取消订阅函数
   */
  on(type: EngineEvent["type"] | "*", handler: EventHandler): () => void {
    const bucket = this.handlers.get(type) ?? new Set<EventHandler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);
    return () => this.off(type, handler);
  }

  /**
   * 取消订阅。
   *
   * @param type 事件类型
   * @param handler 处理器
   */
  off(type: EngineEvent["type"] | "*", handler: EventHandler): void {
    const bucket = this.handlers.get(type);
    bucket?.delete(handler);
    if (bucket && bucket.size === 0) {
      this.handlers.delete(type);
    }
  }

  /**
   * 发射并持久化事件。
   *
   * @param event 引擎事件
   */
  emit(event: EngineEvent): void {
    const maskedEvent: EngineEvent = {
      ...event,
      payload: this.masker(event.payload) as Record<string, unknown>,
    };
    this.emitToSubscribers(maskedEvent);
    this.writeQueue = this.writeQueue.then(() => this.append(maskedEvent)).catch(() => undefined);
  }

  /**
   * 设置脱敏函数。
   *
   * @param masker 脱敏函数
   */
  setMasker(masker: (payload: unknown) => unknown): void {
    this.masker = masker;
  }

  /**
   * 等待队列写入完成。
   */
  async dispose(): Promise<void> {
    await this.writeQueue;
  }

  private emitToSubscribers(event: EngineEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(event);
    }
    for (const handler of this.handlers.get("*") ?? []) {
      handler(event);
    }
  }

  private async append(event: EngineEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.rotateIfNeeded();
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.filePath).catch(() => null);
    if (!info || info.size < this.rotateSize) {
      return;
    }
    const rotatedPath = `${this.filePath}.${Date.now()}.jsonl`;
    await rename(this.filePath, rotatedPath);
  }
}
