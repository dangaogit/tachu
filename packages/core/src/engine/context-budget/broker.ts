import type {
  ContextBudgetAudit,
  ContextBudgetBroker,
  ContextBudgetDecision,
  ContextBudgetEnvelope,
  ContextBudgetRequest,
} from "./types";

const MIN_CONTEXT_TOKENS = 256;

/**
 * 每个 ContextScope 的裁剪优先级序列。
 *
 * 原实现仅 5/10 scope 显式映射，其余 fall-through 到通用
 * `["history", "memory"]`，让 PromptAssembler 无法据此对特定阶段做精确剥离。
 * 现 10 个 scope 全部显式列出；末尾的 `never` exhaustive guard 保证后续新增
 * scope 时必须同步更新本表，否则 typecheck 失败。
 */
const trimOrderFor = (scope: ContextBudgetRequest["scope"]): string[] => {
  switch (scope) {
    case "intent":
 // 意图识别阶段：仅需用户当前轮 + 浅层历史；先丢 recall/skills，再丢老历史。
      return ["recalled-memory", "available-skills", "history"];
    case "main-agent":
      return ["recalled-memory", "available-skills", "history", "tool-definitions"];
    case "direct-answer":
 // 直答阶段：tools/skills 不参与生成；最先丢；最后才动用户上下文。
      return ["tool-definitions", "available-skills", "recalled-memory", "history"];
    case "tool-use-loop":
      return ["old-tool-observations", "old-assistant-turns", "tool-definitions"];
    case "tool-use-final-answer":
      return ["old-observations", "terminal-draft", "user-request"];
    case "fallback-summary":
 // Fallback 摘要阶段：原始 step 详情优先压缩，保留结论与失败原因。
      return ["step-details", "tool-observations", "history"];
    case "validation":
 // 校验阶段：丢历史与 recall，保留 finding + 当前 step output。
      return ["history", "recalled-memory", "available-skills"];
    case "memory-compression":
 // 记忆压缩自身：丢最久远条目；不动 system/instructions。
      return ["oldest-entries", "low-salience-entries"];
    case "sub-agent":
      return ["memory", "previous-results", "tools"];
    case "fan-in-synthesis":
      return ["evidence", "sub-agent-output"];
    default: {
      const exhaustive: never = scope;
      throw new Error(`trimOrderFor: unhandled context scope ${String(exhaustive)}`);
    }
  }
};

const effectiveMaxContext = (request: ContextBudgetRequest): number => {
  const candidates = [
    request.modelMaxContextTokens,
    request.configuredMaxContextTokens,
  ].filter((value): value is number => typeof value === "number" && value > 0);
  return Math.max(MIN_CONTEXT_TOKENS, Math.min(...candidates));
};

export class DefaultContextBudgetBroker implements ContextBudgetBroker {
  decide(request: ContextBudgetRequest): ContextBudgetDecision {
    const maxContextTokens = effectiveMaxContext(request);
    const reserveOutputTokens = Math.max(0, request.reserveOutputTokens);
    const maxInputTokens = Math.max(
      MIN_CONTEXT_TOKENS,
      maxContextTokens - reserveOutputTokens,
    );
    const auditBase: ContextBudgetAudit = {
      scope: request.scope,
      model: request.model,
      maxContextTokens,
      estimatedInputTokens: request.estimatedInputTokens,
      reserveOutputTokens,
      appliedActions: [],
      risk: "none",
    };
    const envelope = (
      actions: ContextBudgetAudit["appliedActions"],
      risk: ContextBudgetAudit["risk"],
    ): ContextBudgetEnvelope => ({
      maxInputTokens,
      reserveOutputTokens,
      trimOrder: trimOrderFor(request.scope),
      compressionAllowed: request.policy.compressionAllowed === true,
      chunkingAllowed: request.policy.chunkingAllowed === true,
      degradeAllowed: request.policy.degradeAllowed !== false,
      audit: {
        ...auditBase,
        appliedActions: actions,
        risk,
      },
    });

    if (request.estimatedInputTokens <= maxInputTokens) {
      return { kind: "fit", envelope: envelope([], "none") };
    }
    if (request.policy.trimAllowed !== false) {
      return { kind: "trim", envelope: envelope(["trim"], "partial-context") };
    }
    if (request.policy.compressionAllowed === true) {
      return {
        kind: "compress",
        envelope: envelope(["compress"], "compressed-input"),
        targets: trimOrderFor(request.scope),
      };
    }
    if (request.policy.chunkingAllowed === true) {
      return {
        kind: "chunk",
        strategy:
          request.inputShape === "tool-observations" ? "map-reduce" : "summarize",
      };
    }
    if (request.policy.degradeAllowed !== false) {
      return {
        kind: "degrade",
        userVisibleReason: "输入超过当前模型上下文预算，已进入降级路径。",
        envelope: envelope(["degrade"], "degraded"),
      };
    }
    return {
      kind: "reject",
      reason: `input estimate ${request.estimatedInputTokens} exceeds max input tokens ${maxInputTokens}`,
      audit: { ...auditBase, risk: "degraded" },
    };
  }
}
