import type { RankedPlan } from "../types";

/**
 * 任务状态。
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * 检查点。
 */
export interface Checkpoint {
  timestamp: number;
  phase: string;
  state: ExecutionState;
}

/**
 * 执行状态。
 */
export interface ExecutionState {
  currentPhase: string;
  activePlan: RankedPlan | null;
  taskProgress: Map<string, TaskStatus>;
  retryCount: {
    task: number;
    system: number;
  };
  budgetUsed: {
    tokens: number;
    durationMs: number;
    toolCalls: number;
  };
  checkpoints: Checkpoint[];
}

/**
 * 运行时状态管理接口。
 */
export interface RuntimeState {
  get(sessionId: string): Promise<ExecutionState | null>;
  update(sessionId: string, state: Partial<ExecutionState>): Promise<void>;
  snapshot(sessionId: string): Promise<Checkpoint | null>;
  restore(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
}

const createInitialState = (): ExecutionState => ({
  currentPhase: "idle",
  activePlan: null,
  taskProgress: new Map(),
  retryCount: {
    task: 0,
    system: 0,
  },
  budgetUsed: {
    tokens: 0,
    durationMs: 0,
    toolCalls: 0,
  },
  checkpoints: [],
});

/**
 * 内存状态实现。
 */
export class InMemoryRuntimeState implements RuntimeState {
  private readonly states = new Map<string, ExecutionState>();

  async get(sessionId: string): Promise<ExecutionState | null> {
    return this.states.get(sessionId) ?? null;
  }

  async update(sessionId: string, state: Partial<ExecutionState>): Promise<void> {
    const current = this.states.get(sessionId) ?? createInitialState();
    const merged: ExecutionState = {
      ...current,
      ...state,
      retryCount: {
        ...current.retryCount,
        ...state.retryCount,
      },
      budgetUsed: {
        ...current.budgetUsed,
        ...state.budgetUsed,
      },
      taskProgress: state.taskProgress ? new Map(state.taskProgress) : new Map(current.taskProgress),
      checkpoints: state.checkpoints ?? current.checkpoints,
    };
    this.states.set(sessionId, merged);
  }

  async snapshot(sessionId: string): Promise<Checkpoint | null> {
    const state = this.states.get(sessionId);
    if (!state) {
      return null;
    }
    const checkpoint: Checkpoint = {
      timestamp: Date.now(),
      phase: state.currentPhase,
      state: {
        ...state,
        taskProgress: new Map(state.taskProgress),
        checkpoints: [...state.checkpoints],
      },
    };
    state.checkpoints.push(checkpoint);
    return checkpoint;
  }

  async restore(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    this.states.set(sessionId, {
      ...checkpoint.state,
      taskProgress: new Map(checkpoint.state.taskProgress),
      checkpoints: [...checkpoint.state.checkpoints],
    });
  }

  async cleanup(sessionId: string): Promise<void> {
    this.states.delete(sessionId);
  }
}

