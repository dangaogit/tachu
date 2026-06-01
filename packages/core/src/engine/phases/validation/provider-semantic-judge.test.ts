import { describe, expect, it } from "bun:test";
import type { ProviderAdapter } from "../../../modules/provider";
import { ProviderSemanticJudgeAdapter } from "./provider-semantic-judge";

describe("ProviderSemanticJudgeAdapter", () => {
  it("parses provider chat JSON findings", async () => {
    const provider: ProviderAdapter = {
      id: "fake",
      name: "Fake",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        return {
          content: JSON.stringify({
            findings: [
              {
                ruleId: "semantic.judge",
                kind: "semantic",
                severity: "warning",
                code: "claim.unsupported",
                message: "claim lacks support",
              },
            ],
          }),
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async *chatStream() {},
    };
    const adapter = new ProviderSemanticJudgeAdapter({ provider, model: "judge-model" });
    const findings = await adapter.judge({
      prompt: "intent=test",
      signals: {
        finalAnswerHasClaims: true,
        hasToolObservations: false,
        hasExternalSources: true,
        hasFileWrites: false,
        hasPartialOrErrorObservations: false,
        descriptorSemanticRequired: false,
        policyMode: "auto",
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("claim.unsupported");
  });

  it("uses custom systemPromptBase when provided", async () => {
    let capturedSystem = "";
    const provider: ProviderAdapter = {
      id: "fake",
      name: "Fake",
      async listAvailableModels() {
        return [];
      },
      async chat(request) {
        capturedSystem =
          typeof request.messages[0]?.content === "string"
            ? request.messages[0].content
            : "";
        return {
          content: JSON.stringify({ findings: [] }),
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async *chatStream() {},
    };
    const adapter = new ProviderSemanticJudgeAdapter({
      provider,
      model: "judge-model",
      systemPromptBase: "HOST-JUDGE-BASE",
    });
    await adapter.judge({
      prompt: "intent=test",
      signals: {
        finalAnswerHasClaims: false,
        hasToolObservations: false,
        hasExternalSources: false,
        hasFileWrites: false,
        hasPartialOrErrorObservations: false,
        descriptorSemanticRequired: false,
        policyMode: "auto",
      },
    });
    expect(capturedSystem).toBe("HOST-JUDGE-BASE");
  });

  it("returns info finding when provider chat throws", async () => {
    const provider: ProviderAdapter = {
      id: "fake",
      name: "Fake",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("upstream");
      },
      async *chatStream() {},
    };
    const adapter = new ProviderSemanticJudgeAdapter({ provider, model: "judge-model" });
    const findings = await adapter.judge({
      prompt: "intent=test",
      signals: {
        finalAnswerHasClaims: false,
        hasToolObservations: false,
        hasExternalSources: false,
        hasFileWrites: false,
        hasPartialOrErrorObservations: false,
        descriptorSemanticRequired: false,
        policyMode: "auto",
      },
    });
    expect(findings[0]?.code).toBe("semantic.judge.parse_failed");
  });
});
