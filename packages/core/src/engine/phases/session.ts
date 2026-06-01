import type { ExecutionContext, InputEnvelope, Message } from "../../types";
import { messageToMemoryEntry } from "../../modules/memory";
import { assembleResources } from "../../utils/resource-pool";
import type { PhaseEnvironment } from "./index";

export interface SessionPhaseOutput {
  input: InputEnvelope;
  context: ExecutionContext;
}

/**
 * 阶段 1：会话上下文装载。
 *
 * core 在此装配——把 `content` 里的重内容 part 抽离为旁路 Resource Pool，
 * 正文末尾追加占位 token；随**同条目** `MemoryEntry` 持久化（仅新 session 写新格式）。
 */
export const runSessionPhase = async (
  input: InputEnvelope,
  context: ExecutionContext,
  env: PhaseEnvironment,
): Promise<SessionPhaseOutput> => {
  await env.sessionManager.resolve(context.correlation.sessionId);
  await env.memorySystem.load(context.correlation.sessionId, env.adapterContext);

  const { content, resources } = assembleResources(input.content as Message["content"]);
  const assembledInput: InputEnvelope =
    resources.length > 0
      ? { ...input, content, resources }
      : { ...input, content };

  await env.memorySystem.append(
    context.correlation.sessionId,
    messageToMemoryEntry({
      role: "user",
      content,
      ...(resources.length > 0 ? { resources } : {}),
    }),
    env.adapterContext,
  );
  await env.runtimeState.update(context.correlation.sessionId, { currentPhase: "session" });
  return { input: assembledInput, context };
};
