import { basename, dirname, extname } from "node:path";
import { ValidationError } from "../errors";

/**
 * agentskills.io 规范的 `name` 格式约束：小写字母、数字、连字符；
 * 不能以连字符开头/结尾，不能出现连续连字符。
 */
const DESCRIPTOR_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const isValidDescriptorNameFormat = (name: string): boolean =>
  DESCRIPTOR_NAME_PATTERN.test(name);

/**
 * 硬校验 name 格式，不合规直接抛 `ValidationError`（对齐 `requireString` 的
 * 失败风格）。格式是四类描述符统一的强约束，不像 dirname/filename 对齐那样
 * 只是软约定。
 */
export const requireValidDescriptorNameFormat = (name: string, sourceFile?: string): void => {
  if (isValidDescriptorNameFormat(name)) return;
  throw ValidationError.invalidConfig(
    `描述符 name "${name}" 不合法：只能包含小写字母、数字与连字符，且不能以连字符开头/结尾或出现连续连字符` +
      (sourceFile ? `（来源：${sourceFile}）` : ""),
  );
};

export const isSkillDirectoryForm = (sourceFile: string): boolean =>
  basename(sourceFile).toLowerCase() === "skill.md";

/**
 * 校验 name 是否与来源标识一致：
 * - Skill 的目录形态（文件名为 `SKILL.md`）：name 应等于父目录名
 * - 其余（rule/tool/agent 单文件形态，以及 Skill 的扁平文件形态）：name 应等于文件名（去扩展名）
 *
 * 不合规只 warn，不阻断加载——tachu 历史上允许扁平命名的技能文件与任意文件名的
 * rule/tool/agent，强改会破坏既有工程组织方式；这里只是对齐 agentskills.io
 * 命名约定的提示，不是硬约束。
 */
export const warnOnDescriptorIdentityMismatch = (
  kind: "rule" | "skill" | "tool" | "agent",
  name: string,
  sourceFile: string | undefined,
): void => {
  if (!sourceFile) return;
  const directoryForm = kind === "skill" && isSkillDirectoryForm(sourceFile);
  const expected = directoryForm
    ? basename(dirname(sourceFile))
    : basename(sourceFile, extname(sourceFile));
  if (expected === name) return;
  console.warn(
    `[tachu] ${kind} "${name}" 的 name 与${directoryForm ? "所在目录名" : "文件名"} "${expected}" 不一致，` +
      `建议保持一致以对齐 agentskills.io 命名约定（来源：${sourceFile}）`,
  );
};
