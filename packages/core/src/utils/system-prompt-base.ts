/** 各阶段 `systemPromptBase` 字段的上限（字节），防止误配超大 prompt。 */
export const SYSTEM_PROMPT_BASE_MAX_BYTES = 32 * 1024;

/**
 * 解析阶段 system prompt base：宿主 override 优先，否则回退 core 内置常量。
 */
export const resolveSystemPromptBase = (
  override: string | undefined,
  defaultBase: string,
): string => override ?? defaultBase;
