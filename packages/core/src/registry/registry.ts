import { RegistryError } from "../errors";
import { compare as compareSemver, prerelease, valid as validSemver } from "semver";
import type {
  AgentDescriptor,
  AnyDescriptor,
  DependencyRef,
  DescriptorMap,
  RuleDescriptor,
  SkillDescriptor,
  ToolDescriptor,
  TriggerCondition,
} from "../types";
import { topologicalSort } from "../utils";
import type { VectorStore } from "../vector";

type DescriptorKind = keyof DescriptorMap;

/**
 * 描述符查询条件。
 */
export interface RegistryQuery {
  tags?: string[];
  trigger?: TriggerCondition["type"];
}

/**
 * 注册中心构造可选项。
 */
export interface RegistryOptions {
 /**
 * @deprecated decision 8 retired Registry-side vector indexing.
 * The option is accepted for source compatibility but ignored.
 */
  vectorStore?: VectorStore;
 /**
 * 保留名集合。
 *
 * 设计目的：引擎内置 Sub-flow（`tool-use`）会被 `tool-routing` phase
 * 规划为 `TaskNode.ref`。如果业务注册同名 Tool/Agent/Skill/Rule，
 * 虽然不会与内置 Sub-flow 直接冲突（TaskExecutor 根据 `type==='sub-flow'` 分流），
 * 但会在可观测日志、向量检索、自定义 TaskExecutor 里引起歧义。因此引擎在
 * 启动期把这些名字标记为保留，任何注册/注销尝试都会显式失败。
 */
  reservedNames?: Iterable<string>;
}

/**
 * 注册中心接口。
 */
export interface Registry {
 /**
 * 注册一个描述符。
 *
 * @param descriptor 待注册描述符
 */
  register(descriptor: AnyDescriptor): Promise<void>;
 /**
 * 注销指定类型与名称的描述符。
 *
 * @param kind 描述符类型
 * @param name 描述符名称
 */
  unregister(kind: DescriptorKind, name: string, version?: string): Promise<void>;
 /**
 * 获取单个描述符。
 *
 * @param kind 描述符类型
 * @param name 描述符名称
 * @returns 匹配项，不存在时返回 null
 */
  get<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null;
  get<K extends DescriptorKind>(kind: K, name: string, version: string): DescriptorMap[K] | null;
  getLatest<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null;
  listVersions<K extends DescriptorKind>(kind: K, name: string): string[];
 /**
 * 列出描述符。
 *
 * @param kind 可选类型过滤
 * @returns 描述符列表
 */
  list<K extends DescriptorKind>(kind?: K): K extends undefined ? AnyDescriptor[] : DescriptorMap[K][];
 /**
 * 按标签与 trigger 条件查询描述符。
 *
 * @param query 查询条件
 * @returns 匹配结果
 */
  query(query: RegistryQuery): AnyDescriptor[];
 /**
 * 清空所有描述符。
 */
  clear(): Promise<void>;
 /**
 * 校验 requires 依赖完整性与依赖图环路。
 *
 * @throws RegistryError | PlanningError
 */
  validateDependencies(): void;
}

/**
 * 统一描述符注册中心。
 */
export class DescriptorRegistry implements Registry {
  private static readonly DEFAULT_VERSION = "0.0.0";
  private readonly rules = new Map<string, Map<string, RuleDescriptor>>();
  private readonly skills = new Map<string, Map<string, SkillDescriptor>>();
  private readonly tools = new Map<string, Map<string, ToolDescriptor>>();
  private readonly agents = new Map<string, Map<string, AgentDescriptor>>();
  private readonly reservedNames: ReadonlySet<string>;

 /**
 * 构造函数，兼容两种传参形态：
 * - `new DescriptorRegistry(vectorStore)`（旧写法，保持向后兼容但忽略 vectorStore）
 * - `new DescriptorRegistry({ vectorStore, reservedNames })`（新写法）
 *
 * 鸭子类型判定：`VectorStore` 暴露 `upsert` 函数，`RegistryOptions` 不会——
 * 以此作为分支依据比 `in` 判定更稳健。
 */
  constructor(optionsOrVectorStore?: VectorStore | RegistryOptions) {
    if (
      optionsOrVectorStore !== undefined &&
      typeof (optionsOrVectorStore as Partial<VectorStore>).upsert === "function"
    ) {
      this.reservedNames = new Set();
    } else {
      const options = (optionsOrVectorStore as RegistryOptions | undefined) ?? {};
      this.reservedNames = new Set(options.reservedNames ?? []);
    }
  }

  async register(descriptor: AnyDescriptor): Promise<void> {
    if (this.reservedNames.has(descriptor.name)) {
      throw RegistryError.reservedName(descriptor.name);
    }
    this.validateGovernanceFields(descriptor);
    const normalizedVersion = this.normalizeVersion(
      descriptor.kind,
      descriptor.name,
      descriptor.version,
    );
    const versionBucket = this.getOrCreateVersionBucket(descriptor.kind, descriptor.name);
    if (versionBucket.has(normalizedVersion)) {
      throw RegistryError.duplicate(descriptor.kind, descriptor.name, normalizedVersion);
    }
    versionBucket.set(normalizedVersion, descriptor as never);
  }

  async unregister(kind: DescriptorKind, name: string, version?: string): Promise<void> {
    if (this.reservedNames.has(name)) {
      throw RegistryError.reservedName(name);
    }
    const bucket = this.getBucket(kind);
    const versionBucket = bucket.get(name);
    if (!versionBucket) {
      return;
    }

    if (version) {
      const normalizedVersion = this.normalizeVersion(kind, name, version);
      versionBucket.delete(normalizedVersion);
      if (versionBucket.size === 0) {
        bucket.delete(name);
      }
      return;
    }

    bucket.delete(name);
  }

  get<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null;
  get<K extends DescriptorKind>(kind: K, name: string, version: string): DescriptorMap[K] | null;
  get<K extends DescriptorKind>(kind: K, name: string, version?: string): DescriptorMap[K] | null {
    if (version) {
      const normalizedVersion = this.normalizeVersion(kind, name, version);
      const versionBucket = this.getBucket(kind).get(name);
      const entry = versionBucket?.get(normalizedVersion);
      return (entry as DescriptorMap[K] | undefined) ?? null;
    }
    return this.getLatest(kind, name);
  }

  getLatest<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null {
    const versionBucket = this.getBucket(kind).get(name);
    if (!versionBucket || versionBucket.size === 0) {
      return null;
    }
    const latestVersion = this.pickLatestVersion(versionBucket);
    const entry = latestVersion ? versionBucket.get(latestVersion) : null;
    return (entry as DescriptorMap[K] | undefined) ?? null;
  }

  listVersions<K extends DescriptorKind>(kind: K, name: string): string[] {
    const versionBucket = this.getBucket(kind).get(name);
    if (!versionBucket || versionBucket.size === 0) {
      return [];
    }
    return [...versionBucket.keys()].sort((left, right) => compareSemver(right, left));
  }

  list<K extends DescriptorKind>(
    kind?: K,
  ): K extends undefined ? AnyDescriptor[] : DescriptorMap[K][] {
    if (!kind) {
      return this.listLatestAcrossKinds() as K extends undefined
        ? AnyDescriptor[]
        : DescriptorMap[K][];
    }
    return this.listLatestInKind(kind) as K extends undefined
      ? AnyDescriptor[]
      : DescriptorMap[K][];
  }

  query(query: RegistryQuery): AnyDescriptor[] {
    return this.list().filter((descriptor) => {
      const tagMatched =
        !query.tags ||
        query.tags.length === 0 ||
        query.tags.some((tag) => descriptor.tags?.includes(tag));
      const triggerMatched = !query.trigger || descriptor.trigger?.type === query.trigger;
      return tagMatched && triggerMatched;
    });
  }

  async clear(): Promise<void> {
    this.rules.clear();
    this.skills.clear();
    this.tools.clear();
    this.agents.clear();
  }

  validateDependencies(): void {
    const descriptors = this.listAllVersions();
    for (const descriptor of descriptors) {
      for (const dep of descriptor.requires ?? []) {
        if (!this.exists(dep)) {
          throw RegistryError.missingDependency(dep.kind, dep.name);
        }
      }
    }

    const nodeIds = new Set(descriptors.map((descriptor) => `${descriptor.kind}:${descriptor.name}`));
    const nodes = [...nodeIds].map((id) => ({
      id,
      type: "sub-flow" as const,
      ref: id,
      input: {},
    }));
    const edgeMap = new Map<string, { from: string; to: string }>();
    for (const descriptor of descriptors) {
      for (const dep of descriptor.requires ?? []) {
        const from = `${descriptor.kind}:${descriptor.name}`;
        const to = `${dep.kind}:${dep.name}`;
        edgeMap.set(`${from}->${to}`, { from, to });
      }
    }
    const edges = [...edgeMap.values()];
    topologicalSort(nodes, edges);
  }

  private exists(dep: DependencyRef): boolean {
    const versions = this.getBucket(dep.kind).get(dep.name);
    return Boolean(versions && versions.size > 0);
  }

  private getBucket<K extends DescriptorKind>(
    kind: K,
  ): Map<string, Map<string, DescriptorMap[K]>> {
    if (kind === "rule") {
      return this.rules as unknown as Map<string, Map<string, DescriptorMap[K]>>;
    }
    if (kind === "skill") {
      return this.skills as unknown as Map<string, Map<string, DescriptorMap[K]>>;
    }
    if (kind === "tool") {
      return this.tools as unknown as Map<string, Map<string, DescriptorMap[K]>>;
    }
    return this.agents as unknown as Map<string, Map<string, DescriptorMap[K]>>;
  }

  private getOrCreateVersionBucket<K extends DescriptorKind>(
    kind: K,
    name: string,
  ): Map<string, DescriptorMap[K]> {
    const bucket = this.getBucket(kind);
    const existing = bucket.get(name);
    if (existing) {
      return existing;
    }
    const created = new Map<string, DescriptorMap[K]>();
    bucket.set(name, created as never);
    return created;
  }

  private listLatestAcrossKinds(): AnyDescriptor[] {
    return [
      ...this.listLatestInKind("rule"),
      ...this.listLatestInKind("skill"),
      ...this.listLatestInKind("tool"),
      ...this.listLatestInKind("agent"),
    ];
  }

  private listLatestInKind<K extends DescriptorKind>(kind: K): DescriptorMap[K][] {
    const bucket = this.getBucket(kind);
    const latest: DescriptorMap[K][] = [];
    for (const versionBucket of bucket.values()) {
      const latestVersion = this.pickLatestVersion(versionBucket);
      if (!latestVersion) {
        continue;
      }
      const descriptor = versionBucket.get(latestVersion);
      if (descriptor) {
        latest.push(descriptor);
      }
    }
    return latest;
  }

  private listAllVersions(): AnyDescriptor[] {
    return [
      ...this.flattenBucket(this.rules),
      ...this.flattenBucket(this.skills),
      ...this.flattenBucket(this.tools),
      ...this.flattenBucket(this.agents),
    ];
  }

  private flattenBucket<K extends DescriptorKind>(
    bucket: Map<string, Map<string, DescriptorMap[K]>>,
  ): DescriptorMap[K][] {
    const descriptors: DescriptorMap[K][] = [];
    for (const versionBucket of bucket.values()) {
      descriptors.push(...versionBucket.values());
    }
    return descriptors;
  }

  private normalizeVersion(kind: DescriptorKind, name: string, rawVersion: string | undefined): string {
    if (rawVersion === undefined || rawVersion.trim().length === 0) {
      return DescriptorRegistry.DEFAULT_VERSION;
    }
    const normalized = validSemver(rawVersion.trim());
    if (!normalized) {
      throw RegistryError.invalidVersion(kind, name, rawVersion);
    }
    return normalized;
  }

  private pickLatestVersion<T>(versionBucket: Map<string, T>): string | null {
    const versions = [...versionBucket.keys()];
    if (versions.length === 0) {
      return null;
    }
    const stableVersions = versions.filter((version) => prerelease(version) === null);
    const candidates = stableVersions.length > 0 ? stableVersions : versions;
    return candidates.sort((left, right) => compareSemver(right, left))[0] ?? null;
  }

  private validateGovernanceFields(descriptor: AnyDescriptor): void {
    if (descriptor.deprecated !== true) {
      return;
    }
    if (
      descriptor.deprecatedMessage === undefined ||
      descriptor.deprecatedMessage.trim().length === 0
    ) {
      throw RegistryError.deprecatedMessageRequired(descriptor.kind, descriptor.name);
    }
  }
}
