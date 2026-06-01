import type { EngineEvent } from "../types";
import { maskSensitiveData } from "../utils";

type EventHandler = (event: EngineEvent) => void;

/**
 * 可观测性发射器接口。
 */
export interface ObservabilityEmitter {
  on(type: EngineEvent["type"] | "*", handler: EventHandler): () => void;
  off(type: EngineEvent["type"] | "*", handler: EventHandler): void;
  emit(event: EngineEvent): void;
  setMasker(masker: (payload: unknown) => unknown): void;
}

/**
 * 默认 EventEmitter 风格实现。
 */
export class DefaultObservabilityEmitter implements ObservabilityEmitter {
  private readonly handlers = new Map<EngineEvent["type"] | "*", Set<EventHandler>>();
  private masker: (payload: unknown) => unknown = maskSensitiveData;

  on(type: EngineEvent["type"] | "*", handler: EventHandler): () => void {
    const bucket = this.handlers.get(type) ?? new Set<EventHandler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);
    return () => this.off(type, handler);
  }

  off(type: EngineEvent["type"] | "*", handler: EventHandler): void {
    const bucket = this.handlers.get(type);
    bucket?.delete(handler);
    if (bucket && bucket.size === 0) {
      this.handlers.delete(type);
    }
  }

  emit(event: EngineEvent): void {
    const maskedEvent: EngineEvent = {
      ...event,
      payload: this.masker(event.payload) as Record<string, unknown>,
    };
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(maskedEvent);
    }
    for (const handler of this.handlers.get("*") ?? []) {
      handler(maskedEvent);
    }
  }

  setMasker(masker: (payload: unknown) => unknown): void {
    this.masker = masker;
  }
}

