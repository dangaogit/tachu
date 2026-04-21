import { resolve } from "node:path";

/**
 * 内置规则描述符文件路径。
 */
export const BUILTIN_RULE_DESCRIPTOR_PATHS: Record<string, string> = {
  "no-sensitive-output": resolve(import.meta.dir, "no-sensitive-output.md"),
  "prefer-concise-response": resolve(import.meta.dir, "prefer-concise-response.md"),
  "no-hallucination": resolve(import.meta.dir, "no-hallucination.md"),
  "require-tool-verification": resolve(import.meta.dir, "require-tool-verification.md"),
};

/**
 * 内置规则文件路径列表。
 */
export const builtinRuleDescriptorPaths = Object.values(BUILTIN_RULE_DESCRIPTOR_PATHS);
