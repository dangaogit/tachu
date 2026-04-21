import { EngineError } from "@tachu/core";

/**
 * CLI 层基础错误。
 */
export class CliError extends EngineError {
  /**
   * @param code 错误码（CLI_ 前缀）
   * @param message 描述
   * @param cause 原始错误
   */
  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, cause !== undefined ? { cause } : undefined);
    this.name = "CliError";
  }
}

/**
 * 配置文件加载失败。
 */
export class ConfigLoadError extends CliError {
  /**
   * @param message 描述
   * @param cause 原始错误
   */
  constructor(message: string, cause?: unknown) {
    super("CLI_CONFIG_LOAD_ERROR", message, cause);
    this.name = "ConfigLoadError";
  }
}

/**
 * 描述符扫描失败。
 */
export class DescriptorScanError extends CliError {
  /**
   * @param message 描述
   * @param cause 原始错误
   */
  constructor(message: string, cause?: unknown) {
    super("CLI_DESCRIPTOR_SCAN_ERROR", message, cause);
    this.name = "DescriptorScanError";
  }
}

/**
 * Session 持久化失败。
 */
export class SessionStoreError extends CliError {
  /**
   * @param message 描述
   * @param cause 原始错误
   */
  constructor(message: string, cause?: unknown) {
    super("CLI_SESSION_STORE_ERROR", message, cause);
    this.name = "SessionStoreError";
  }
}

/**
 * CLI 命令参数错误。
 */
export class CliArgumentError extends CliError {
  /**
   * @param message 描述
   */
  constructor(message: string) {
    super("CLI_ARGUMENT_ERROR", message);
    this.name = "CliArgumentError";
  }
}

/**
 * 将任意错误格式化为用户友好的字符串。
 *
 * @param err 任意错误对象
 * @returns 格式化字符串
 */
export function formatError(err: unknown): string {
  if (err instanceof EngineError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
