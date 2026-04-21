const API_KEY_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /(?:api[-_ ]?key|token|secret)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{8,})["']?/gi,
];

/**
 * 对对象中的敏感字符串执行脱敏。
 */
export const maskSensitiveData = (payload: unknown): unknown => {
  if (typeof payload === "string") {
    return API_KEY_PATTERNS.reduce(
      (text, pattern) => text.replace(pattern, "[MASKED]"),
      payload,
    );
  }
  if (Array.isArray(payload)) {
    return payload.map(maskSensitiveData);
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const input = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/password|secret|token|apiKey/i.test(key)) {
      out[key] = "[MASKED]";
    } else {
      out[key] = maskSensitiveData(value);
    }
  }
  return out;
};

