/**
 * 启动期配置校验失败时抛出。
 */
export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError";

  constructor(
    public readonly field: string | undefined,
    public readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(
      field !== undefined ? `[${field}] ${reason}` : reason,
      options,
    );
  }
}
