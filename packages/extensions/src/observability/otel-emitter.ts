import type { EngineEvent, ObservabilityEmitter } from "@tachu/core";
import type { Tracer } from "@opentelemetry/api";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";

type EventHandler = (event: EngineEvent) => void;

/**
 * 基于 OpenTelemetry 的 ObservabilityEmitter 实现。
 */
export class OtelEmitter implements ObservabilityEmitter {
  private readonly handlers = new Map<EngineEvent["type"] | "*", Set<EventHandler>>();
  private readonly phaseSpans = new Map<string, ReturnType<Tracer["startSpan"]>>();
  private masker: (payload: unknown) => unknown = (payload) => payload;

  /**
   * 创建 OTel 发射器。
   *
   * @param options 构造参数
   */
  constructor(private readonly options: { tracer: Tracer }) {}

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
   * 发射事件并映射到 OTel Span。
   *
   * @param event 引擎事件
   */
  emit(event: EngineEvent): void {
    const maskedEvent: EngineEvent = {
      ...event,
      payload: this.masker(event.payload) as Record<string, unknown>,
    };
    this.emitToSubscribers(maskedEvent);
    this.emitToOtel(maskedEvent);
  }

  /**
   * 配置 payload 脱敏函数。
   *
   * @param masker 脱敏函数
   */
  setMasker(masker: (payload: unknown) => unknown): void {
    this.masker = masker;
  }

  private emitToSubscribers(event: EngineEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(event);
    }
    for (const handler of this.handlers.get("*") ?? []) {
      handler(event);
    }
  }

  private emitToOtel(event: EngineEvent): void {
    const phaseKey = `${event.traceId}:${event.sessionId}:${event.phase}`;
    if (event.type === "phase_enter") {
      const span = this.options.tracer.startSpan(`phase:${event.phase}`, {
        attributes: {
          "engine.trace_id": event.traceId,
          "engine.session_id": event.sessionId,
          "engine.phase": event.phase,
        },
        startTime: event.timestamp,
      });
      this.phaseSpans.set(phaseKey, span);
      return;
    }

    if (event.type === "phase_exit") {
      const span = this.phaseSpans.get(phaseKey);
      if (span) {
        if (event.payload.error) {
          span.recordException(event.payload.error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: "phase failed" });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(event.timestamp);
        this.phaseSpans.delete(phaseKey);
      }
      return;
    }

    const parent = this.phaseSpans.get(phaseKey);
    const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
    const span = this.options.tracer.startSpan(`event:${event.type}`, {
      attributes: {
        "engine.trace_id": event.traceId,
        "engine.session_id": event.sessionId,
        "engine.phase": event.phase,
        "engine.event_type": event.type,
      },
      startTime: event.timestamp,
    }, parentContext);

    if (event.type.startsWith("llm")) {
      this.setIfPresent(span, "llm.provider", event.payload.provider);
      this.setIfPresent(span, "llm.model", event.payload.model);
      this.setIfPresent(span, "llm.tokens.prompt", event.payload.promptTokens);
      this.setIfPresent(span, "llm.tokens.completion", event.payload.completionTokens);
    }
    if (event.type.startsWith("tool")) {
      this.setIfPresent(span, "tool.name", event.payload.name);
      this.setIfPresent(span, "tool.side_effect", event.payload.sideEffect);
    }
    if (event.type === "error" || event.payload.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "engine error" });
      if (event.payload.error instanceof Error) {
        span.recordException(event.payload.error);
      } else if (event.payload.error) {
        span.recordException(new Error(String(event.payload.error)));
      }
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end(event.timestamp);
  }

  private setIfPresent(
    span: ReturnType<Tracer["startSpan"]>,
    key: string,
    value: unknown,
  ): void {
    if (value !== undefined) {
      span.setAttribute(key, value as never);
    }
  }
}
