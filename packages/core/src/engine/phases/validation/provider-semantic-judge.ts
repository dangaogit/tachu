import type { AdapterCallContext } from "../../../types/context";
import type { ChatRequest, ProviderAdapter } from "../../../modules/provider";
import type { ValidationFinding } from "../../../types";
import type { SemanticJudgeAdapter, SemanticJudgeInput } from "./semantic-judge";

export interface ProviderSemanticJudgeAdapterOptions {
  provider: ProviderAdapter;
  model: string;
  temperature?: number | undefined;
 /** 替换默认 semantic judge system prompt；未设则用 core 内置常量。 */
  systemPromptBase?: string;
}

const SYSTEM_PROMPT = `You are a validation semantic judge. Given validation signals and context, respond with JSON only:
{"findings":[{"ruleId":"semantic.judge","kind":"semantic","severity":"warning|info|error","code":"string","message":"string"}]}
If no issues, return {"findings":[]}.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseFindings = (raw: string): readonly ValidationFinding[] => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return [];
  const findings: ValidationFinding[] = [];
  for (const item of parsed.findings) {
    if (!isRecord(item)) continue;
    if (typeof item.ruleId !== "string" || typeof item.code !== "string") continue;
    if (typeof item.message !== "string") continue;
    const severity = item.severity;
    if (severity !== "info" && severity !== "warning" && severity !== "error") continue;
    const kind = item.kind === "semantic" ? "semantic" : "semantic";
    findings.push({
      ruleId: item.ruleId,
      kind,
      severity,
      code: item.code,
      message: item.message,
    });
  }
  return findings;
};

/**
 * Wraps {@link ProviderAdapter.chat} as a {@link SemanticJudgeAdapter}.
 */
export class ProviderSemanticJudgeAdapter implements SemanticJudgeAdapter {
  constructor(private readonly options: ProviderSemanticJudgeAdapterOptions) {}

  async judge(input: SemanticJudgeInput): Promise<readonly ValidationFinding[]> {
    const ctx: AdapterCallContext = {
      correlation: {
        traceId: "semantic-judge",
        requestId: "semantic-judge",
        sessionId: "semantic-judge",
        turnId: "semantic-judge",
      },
    };
    const request: ChatRequest = {
      model: this.options.model,
      messages: [
        {
          role: "system",
          content: this.options.systemPromptBase ?? SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `${input.prompt}\n\nsignals=${JSON.stringify(input.signals)}`,
        },
      ],
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      responseFormat: { type: "json_object" },
    } as ChatRequest;
    try {
      const response = await this.options.provider.chat(request, ctx);
      return parseFindings(response.content);
    } catch {
      return [
        {
          ruleId: "semantic.judge",
          kind: "semantic",
          severity: "info",
          code: "semantic.judge.parse_failed",
          message: "semantic judge response could not be parsed; deterministic only",
        },
      ];
    }
  }
}
