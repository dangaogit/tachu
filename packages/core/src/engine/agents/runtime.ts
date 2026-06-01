import type { Message } from "../../types";
import type { EvidenceEntry } from "../../types/evidence";
import type {
  AgentInvocation,
  AgentRunError,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeOptions,
} from "./types";

const fail = (
  code: string,
  message: string,
  retryable = false,
): { status: "failed"; error: AgentRunError } => ({
  status: "failed",
  error: { code, message, retryable },
});

const serializeInput = (input: Record<string, unknown>): string => {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
};

const renderStructured = (
  structured: NonNullable<AgentInvocation["context"]["inherited"]["structured"]>,
): string[] => {
  const lines: string[] = [];
  if (structured.instructions && structured.instructions.length > 0) {
    lines.push(`Additional instructions:\n- ${structured.instructions.join("\n- ")}`);
  }
  if (structured.rules && structured.rules.length > 0) {
    lines.push(
      `Rules:\n${structured.rules.map((rule) => `- ${serializeInput(rule as Record<string, unknown>).replace(/\n/g, " ")}`).join("\n")}`,
    );
  }
  if (structured.evidence && structured.evidence.length > 0) {
    lines.push(
      `Evidence:\n${structured.evidence
        .map(
          (entry, idx) =>
            `[${idx + 1}] ${entry.source}: ${serializeInput(entry.content as Record<string, unknown>)}`,
        )
        .join("\n")}`,
    );
  }
  if (structured.priorTurns && structured.priorTurns.length > 0) {
    lines.push(
      `Prior turns (most recent first):\n${structured.priorTurns
        .map((turn) => {
          const text =
            typeof turn.content === "string"
              ? turn.content
              : Array.isArray(turn.content)
                ? turn.content
                    .map((part) => (part as { text?: string }).text ?? "")
                    .filter((value) => value.length > 0)
                    .join(" ")
                : "";
          return `- [${turn.role}] ${text}`;
        })
        .join("\n")}`,
    );
  }
  return lines;
};

const buildMessages = (invocation: AgentInvocation): Message[] => {
  const allowedTools =
    invocation.constraints.allowedTools.length > 0
      ? invocation.constraints.allowedTools.join(", ")
      : "none";
  const inherited = invocation.context.inherited;
  const contextLines = [
    `Scope: ${invocation.context.scope}`,
    `Parent trace: ${invocation.context.parentTraceId}`,
    `Allowed tools: ${allowedTools}`,
    `Memory: ${inherited.memory ?? "none"}`,
    `Budget: input=${invocation.context.budget.maxInputTokens}, working=${invocation.context.budget.maxWorkingTokens}, output=${invocation.context.budget.maxOutputTokens}`,
  ];
  if (inherited.structured) {
    contextLines.push(...renderStructured(inherited.structured));
  } else if (inherited.previousResults && inherited.previousResults.length > 0) {
    contextLines.push(`Previous results:\n${inherited.previousResults.join("\n---\n")}`);
  }
  const system = [
    `You are the "${invocation.agent.name}" sub-agent.`,
    invocation.agent.instructions,
    "",
    "You must complete only the scoped objective. Do not assume access to context outside the envelope.",
    "If the objective cannot be completed from the provided input, return the best partial result and state the limitation.",
  ].join("\n");
  const user = [
    `Objective:\n${invocation.objective}`,
    "",
    "Context envelope:",
    contextLines.join("\n"),
    "",
    "Input:",
    serializeInput(invocation.input),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
};

export class DefaultAgentRuntimeAdapter implements AgentRuntimeAdapter {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(
    invocation: AgentInvocation,
    _executionContext: import("../../types").ExecutionContext,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const currentDepth = invocation.constraints.currentDepth ?? 1;
    if (
      invocation.constraints.maxDepth <= 0 ||
      invocation.agent.maxDepth <= 0 ||
      currentDepth > invocation.constraints.maxDepth ||
      currentDepth > invocation.agent.maxDepth
    ) {
      return fail(
        "AGENT_MAX_DEPTH_EXCEEDED",
        `agent "${invocation.agent.name}" cannot be dispatched because maxDepth is exhausted (currentDepth=${currentDepth}, constraint.maxDepth=${invocation.constraints.maxDepth}, descriptor.maxDepth=${invocation.agent.maxDepth})`,
      );
    }
    if (signal.aborted) {
      return { status: "cancelled", reason: "aborted before agent dispatch" };
    }
    const { toolUseExecutor, toolUseContextFactory } = this.options;
    if (toolUseExecutor && toolUseContextFactory) {
      try {
        const ctx = toolUseContextFactory(invocation, signal, _executionContext);
        const promptBody = [
          `Objective:\n${invocation.objective}`,
          "",
          "Input:",
          serializeInput(invocation.input),
        ].join("\n");
        const toolUseInput = {
          prompt: promptBody,
          ...(invocation.constraints.allowedTools.length > 0
            ? { toolNames: invocation.constraints.allowedTools }
            : {}),
        };
        const result = await toolUseExecutor.execute(toolUseInput as never, ctx);
        if (signal.aborted) {
          return { status: "cancelled", reason: "agent run cancelled" };
        }
        if (result.status === "failed") {
          return fail(
            result.error?.code ?? "AGENT_TOOL_USE_FAILED",
            result.error?.message ?? "sub-agent tool-use failed",
            result.error?.retryable ?? true,
          );
        }
        return {
          status: "completed",
          output: result.terminalDraft ?? "",
          evidence: [
            {
              source: `agent-run:${invocation.id}`,
              content: {
                agent: invocation.agent.name,
                provider: this.options.route.provider,
                model: this.options.route.model,
                objective: invocation.objective,
                mode: "tool-use",
                steps: result.steps?.length ?? 0,
              },
              producedBy: "agent-runtime",
              purpose: "execution-observation",
              agentRunId: invocation.id,
            } satisfies EvidenceEntry,
          ],
        };
      } catch (error) {
        if (signal.aborted) {
          return {
            status: "cancelled",
            reason: error instanceof Error ? error.message : "agent run cancelled",
          };
        }
        return fail(
          "AGENT_RUN_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    }
    const provider = this.options.providers.get(this.options.route.provider);
    if (!provider) {
      return fail(
        "AGENT_PROVIDER_UNAVAILABLE",
        `provider "${this.options.route.provider}" is not registered`,
        true,
      );
    }
    try {
      const response = await provider.chat(
        {
          model: this.options.route.model,
          messages: buildMessages(invocation),
          maxTokens: invocation.context.budget.maxOutputTokens,
        },
        this.options.adapterContext,
        signal,
      );
      return {
        status: "completed",
        output: response.content,
        usage: response.usage,
        evidence: [
          {
            source: `agent-run:${invocation.id}`,
            content: {
              agent: invocation.agent.name,
              provider: provider.id,
              model: this.options.route.model,
              objective: invocation.objective,
            },
            producedBy: "agent-runtime",
            purpose: "execution-observation",
            agentRunId: invocation.id,
          } satisfies EvidenceEntry,
        ],
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          status: "cancelled",
          reason: error instanceof Error ? error.message : "agent run cancelled",
        };
      }
      return fail(
        "AGENT_RUN_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}
