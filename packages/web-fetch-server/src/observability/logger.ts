/**
 * Structured JSONL logger for `@tachu/web-fetch-server`.
 *
 * Log levels align with `WEB_FETCH_LOG_LEVEL` in ADR-0003c (`debug` / `info` / `warn` / `error`).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal writable surface for JSONL lines (defaults to `process.stdout`).
 */
export interface WritableStreamLike {
  write(chunk: string): void | boolean | Promise<void>;
}

export interface Logger {
  /** Emit a debug-level line when the logger level allows it. */
  debug(msg: string, fields?: Record<string, unknown>): void;
  /** Emit an info-level line when the logger level allows it. */
  info(msg: string, fields?: Record<string, unknown>): void;
  /** Emit a warn-level line when the logger level allows it. */
  warn(msg: string, fields?: Record<string, unknown>): void;
  /** Emit an error-level line when the logger level allows it. */
  error(msg: string, fields?: Record<string, unknown>): void;
  /**
   * Returns a new logger that merges `bindings` into every subsequent log record
   * (per-call `fields` override keys from bindings).
   */
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLevelEnabled(configLevel: LogLevel, messageLevel: LogLevel): boolean {
  return LEVEL_RANK[messageLevel] >= LEVEL_RANK[configLevel];
}

/**
 * Returns a `JSON.stringify` replacer that replaces circular references with `"[Circular]"`.
 */
export function replaceCircular(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (value !== null && typeof value === "object") {
      const obj = value as object;
      if (seen.has(obj)) {
        return "[Circular]";
      }
      seen.add(obj);
    }
    return value;
  };
}

function writeLine(
  stream: WritableStreamLike,
  record: Record<string, unknown>,
): void {
  const line = `${JSON.stringify(record, replaceCircular())}\n`;
  void stream.write(line);
}

export type CreateLoggerOptions = {
  level: LogLevel;
  stream?: WritableStreamLike;
};

/**
 * Creates a JSONL logger. Records are one JSON object per line, ending with `\n`.
 *
 * Fields: `{ ts: ISO8601, level, msg, ...fields }`. Messages below `opts.level` are dropped.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const stream = opts.stream ?? (process.stdout as WritableStreamLike);
  return createLoggerWithBindings(opts.level, stream, {});
}

/**
 * No-op logger used as a safe default for libraries/routes that accept an optional logger.
 * Methods are bound so the returned object can be destructured without losing `this`.
 */
export const noopLogger: Logger = (() => {
  const self: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return self;
    },
  };
  return self;
})();

function createLoggerWithBindings(
  configLevel: LogLevel,
  stream: WritableStreamLike,
  bindings: Record<string, unknown>,
): Logger {
  const emit = (
    messageLevel: LogLevel,
    msg: string,
    fields: Record<string, unknown> | undefined,
  ): void => {
    if (!isLevelEnabled(configLevel, messageLevel)) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: messageLevel,
      msg,
      ...bindings,
      ...(fields ?? {}),
    };
    writeLine(stream, record);
  };

  return {
    debug(msg, fields) {
      emit("debug", msg, fields);
    },
    info(msg, fields) {
      emit("info", msg, fields);
    },
    warn(msg, fields) {
      emit("warn", msg, fields);
    },
    error(msg, fields) {
      emit("error", msg, fields);
    },
    child(extra) {
      return createLoggerWithBindings(configLevel, stream, {
        ...bindings,
        ...extra,
      });
    },
  };
}
