import type { ExecutionContext, InputEnvelope } from "../../types";
import { messageToMemoryEntry } from "../../modules/memory";
import type { PhaseEnvironment } from "./index";

export interface SessionPhaseOutput {
  input: InputEnvelope;
  context: ExecutionContext;
}

/**
 * 阶段 1：会话上下文装载。
 */
export const runSessionPhase = async (
  input: InputEnvelope,
  context: ExecutionContext,
  env: PhaseEnvironment,
): Promise<SessionPhaseOutput> => {
  await env.sessionManager.resolve(context.sessionId);
  await env.memorySystem.load(context.sessionId);
  await env.memorySystem.append(
    context.sessionId,
    messageToMemoryEntry({
      role: "user",
      content: typeof input.content === "string" ? input.content : JSON.stringify(input.content),
    }),
  );
  await env.runtimeState.update(context.sessionId, { currentPhase: "session" });
  return { input, context };
};

