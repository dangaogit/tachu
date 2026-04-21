import { RegistryError } from "../errors";
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
  /** 向量存储，可选；注入后所有 register/unregister 会同步到向量索引。 */
  vectorStore?: VectorStore;
  /**
   * 保留名集合。
   *
   * 设计目的：引擎内置 Sub-flow（`direct-answer` / `tool-use`）会被 Phase 5
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
  unregister(kind: DescriptorKind, name: string): Promise<void>;
  /**
   * 获取单个描述符。
   *
   * @param kind 描述符类型
   * @param name 描述符名称
   * @returns 匹配项，不存在时返回 null
   */
  get<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null;
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
  private readonly rules = new Map<string, RuleDescriptor>();
  private readonly skills = new Map<string, SkillDescriptor>();
  private readonly tools = new Map<string, ToolDescriptor>();
  private readonly agents = new Map<string, AgentDescriptor>();
  private readonly vectorStore: VectorStore | undefined;
  private readonly reservedNames: ReadonlySet<string>;

  /**
   * 构造函数，兼容两种传参形态：
   *   - `new DescriptorRegistry(vectorStore)`（旧写法，保持向后兼容）
   *   - `new DescriptorRegistry({ vectorStore, reservedNames })`（新写法）
   *
   * 鸭子类型判定：`VectorStore` 暴露 `upsert` 函数，`RegistryOptions` 不会——
   * 以此作为分支依据比 `in` 判定更稳健。
   */
  constructor(optionsOrVectorStore?: VectorStore | RegistryOptions) {
    if (
      optionsOrVectorStore !== undefined &&
      typeof (optionsOrVectorStore as Partial<VectorStore>).upsert === "function"
    ) {
      this.vectorStore = optionsOrVectorStore as VectorStore;
      this.reservedNames = new Set();
    } else {
      const options = (optionsOrVectorStore as RegistryOptions | undefined) ?? {};
      this.vectorStore = options.vectorStore;
      this.reservedNames = new Set(options.reservedNames ?? []);
    }
  }

  async register(descriptor: AnyDescriptor): Promise<void> {
    if (this.reservedNames.has(descriptor.name)) {
      throw RegistryError.reservedName(descriptor.name);
    }
    const bucket = this.getBucket(descriptor.kind);
    if (bucket.has(descriptor.name)) {
      throw RegistryError.duplicate(descriptor.kind, descriptor.name);
    }
    bucket.set(descriptor.name, descriptor as never);

    if (this.vectorStore) {
      await this.vectorStore.upsert(
        `${descriptor.kind}:${descriptor.name}`,
        `${descriptor.description}\n${descriptor.tags?.join(",") ?? ""}`,
        {
          kind: descriptor.kind,
          name: descriptor.name,
          description: descriptor.description,
          tags: descriptor.tags ?? [],
        },
      );
    }
  }

  async unregister(kind: DescriptorKind, name: string): Promise<void> {
    if (this.reservedNames.has(name)) {
      throw RegistryError.reservedName(name);
    }
    this.getBucket(kind).delete(name);
    if (this.vectorStore) {
      await this.vectorStore.delete(`${kind}:${name}`);
    }
  }

  get<K extends DescriptorKind>(kind: K, name: string): DescriptorMap[K] | null {
    const entry = this.getBucket(kind).get(name);
    return (entry as DescriptorMap[K] | undefined) ?? null;
  }

  list<K extends DescriptorKind>(
    kind?: K,
  ): K extends undefined ? AnyDescriptor[] : DescriptorMap[K][] {
    if (!kind) {
      return [
        ...this.rules.values(),
        ...this.skills.values(),
        ...this.tools.values(),
        ...this.agents.values(),
      ] as K extends undefined ? AnyDescriptor[] : DescriptorMap[K][];
    }
    return [...this.getBucket(kind).values()] as K extends undefined
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
    if (this.vectorStore) {
      await this.vectorStore.clear();
    }
  }

  validateDependencies(): void {
    const descriptors = this.list();
    for (const descriptor of descriptors) {
      for (const dep of descriptor.requires ?? []) {
        if (!this.exists(dep)) {
          throw RegistryError.missingDependency(dep.kind, dep.name);
        }
      }
    }

    const nodes = descriptors.map((descriptor) => ({
      id: `${descriptor.kind}:${descriptor.name}`,
      type: "sub-flow" as const,
      ref: descriptor.name,
      input: {},
    }));
    const edges = descriptors.flatMap((descriptor) =>
      (descriptor.requires ?? []).map((dep) => ({
        from: `${descriptor.kind}:${descriptor.name}`,
        to: `${dep.kind}:${dep.name}`,
      })),
    );
    topologicalSort(nodes, edges);
  }

  private exists(dep: DependencyRef): boolean {
    return this.getBucket(dep.kind).has(dep.name);
  }

  private getBucket<K extends DescriptorKind>(
    kind: K,
  ): Map<string, DescriptorMap[K]> {
    if (kind === "rule") {
      return this.rules as unknown as Map<string, DescriptorMap[K]>;
    }
    if (kind === "skill") {
      return this.skills as unknown as Map<string, DescriptorMap[K]>;
    }
    if (kind === "tool") {
      return this.tools as unknown as Map<string, DescriptorMap[K]>;
    }
    return this.agents as unknown as Map<string, DescriptorMap[K]>;
  }
}

