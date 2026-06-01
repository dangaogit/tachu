import type { RetrievalCaller, RetrievalPolicy, RetrievalPolicyRegistry } from "./types";

/**
 * 默认 RetrievalPolicy 注册表。
 *
 * 提供三类 caller 的合理默认值，host 可通过 `override(caller, namespace, policy)` 覆盖。
 * 设计要点：
 * - skill: top-5、cosine 阈值 0.2、embedding 未就绪时本地扫描兜底（保留可用性）
 * - tool: top-8、阈值 0.18（工具描述差异更细）、本地扫描兜底
 * - memory: top-10、阈值 0.25（避免脏记忆污染主上下文）、embedding 缺失时 bypass
 * （记忆召回宁缺勿滥）
 *
 * 这些默认值不是硬合约，而是对"无 host 覆盖时应得到可工作的语义检索"的
 * 可观测承诺。后续 dogfood 数据出来后可调整，但禁止悄无声息地回到"全 bypass"。
 */
export interface DefaultRetrievalPolicyRegistryOptions {
  overrides?: ReadonlyArray<{
    caller: RetrievalCaller;
    namespace?: string;
    policy: RetrievalPolicy;
  }>;
}

const DEFAULTS: Record<RetrievalCaller, RetrievalPolicy> = {
  skill: { topK: 5, minScoreThreshold: 0.2, staleFallback: "local_scan" },
  tool: { topK: 8, minScoreThreshold: 0.18, staleFallback: "local_scan" },
  memory: { topK: 10, minScoreThreshold: 0.25, staleFallback: "bypass_semantic" },
};

const keyOf = (caller: RetrievalCaller, namespace: string): string =>
  `${caller}::${namespace}`;

export class DefaultRetrievalPolicyRegistry implements RetrievalPolicyRegistry {
  private readonly overrides = new Map<string, RetrievalPolicy>();
  private readonly callerOverrides = new Map<RetrievalCaller, RetrievalPolicy>();

  constructor(options: DefaultRetrievalPolicyRegistryOptions = {}) {
    for (const entry of options.overrides ?? []) {
      if (entry.namespace) {
        this.overrides.set(keyOf(entry.caller, entry.namespace), entry.policy);
      } else {
        this.callerOverrides.set(entry.caller, entry.policy);
      }
    }
  }

  get(caller: RetrievalCaller, namespace: string): RetrievalPolicy {
    const ns = this.overrides.get(keyOf(caller, namespace));
    if (ns) return ns;
    const callerWide = this.callerOverrides.get(caller);
    if (callerWide) return callerWide;
    return DEFAULTS[caller];
  }
}

export const DEFAULT_RETRIEVAL_POLICIES: Readonly<Record<RetrievalCaller, RetrievalPolicy>> =
  DEFAULTS;
