/**
 * 会话生命周期状态。
 */
export type SessionStatus = "active" | "suspended" | "closed";

/**
 * 会话对象。
 */
export interface Session {
  id: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * 运行句柄：由 `beginRun` 返回，表示一次 run 的取消/释放能力。
 *
 * - `signal`：当 `cancel(sessionId, reason)` 或上层 `last-message-wins` 触发时被 abort。
 * - `requestId`：对应 `ExecutionContext.requestId`，用于日志/可观测追踪。
 * - `release()`：主流程结束后释放句柄；重复调用安全，但不会重新激活 signal。
 */
export interface RunHandle {
  signal: AbortSignal;
  requestId: string;
  release(): void;
}

interface SessionRuntime {
  session: Session;
  currentRun: AbortController | undefined;
  currentRequestId: string | undefined;
  history: unknown[];
  runtimeState: Map<string, unknown>;
}

/**
 * listSessions 过滤器。
 */
export interface SessionListFilter {
  status?: SessionStatus;
}

/**
 * 会话管理接口（按 detailed-design.md §9.1 规约）。
 */
export interface SessionManager {
  // 基础生命周期
  resolve(sessionId: string): Promise<Session>;
  suspend(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;

  // 取消传播
  beginRun(sessionId: string, requestId: string): RunHandle;
  cancel(sessionId: string, reason?: string): Promise<void>;
  clear(sessionId: string): Promise<void>;

  // 运维 / 可观测
  getSession(sessionId: string): Session | undefined;
  listSessions(filter?: SessionListFilter): Session[];
  removeSession(sessionId: string): Promise<void>;
  cleanupInactive(olderThanMs: number): Promise<number>;
}

/**
 * 默认内存 SessionManager。
 */
export class InMemorySessionManager implements SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();

  async resolve(sessionId: string): Promise<Session> {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.session.status = "active";
      existing.session.lastActiveAt = now;
      return existing.session;
    }

    const session: Session = {
      id: sessionId,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(sessionId, {
      session,
      currentRun: undefined,
      currentRequestId: undefined,
      history: [],
      runtimeState: new Map<string, unknown>(),
    });
    return session;
  }

  async suspend(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.session.status = "suspended";
    runtime.session.lastActiveAt = Date.now();
    runtime.currentRun?.abort("session-suspended");
    runtime.currentRun = undefined;
    runtime.currentRequestId = undefined;
  }

  async close(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.session.status = "closed";
    runtime.currentRun?.abort("session-closed");
    runtime.currentRun = undefined;
    runtime.currentRequestId = undefined;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  listSessions(filter?: SessionListFilter): Session[] {
    const sessions = [...this.sessions.values()].map((item) => item.session);
    if (!filter) {
      return sessions;
    }
    return sessions.filter((session) => {
      if (filter.status !== undefined && session.status !== filter.status) {
        return false;
      }
      return true;
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    runtime?.currentRun?.abort("session-removed");
    this.sessions.delete(sessionId);
  }

  async cleanupInactive(olderThanMs: number): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [sessionId, runtime] of this.sessions.entries()) {
      if (now - runtime.session.lastActiveAt > olderThanMs) {
        runtime.currentRun?.abort("session-cleanup");
        this.sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  beginRun(sessionId: string, requestId: string): RunHandle {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`session not found: ${sessionId}`);
    }
    runtime.currentRun?.abort("last-message-wins");
    const controller = new AbortController();
    runtime.currentRun = controller;
    runtime.currentRequestId = requestId;
    runtime.session.lastActiveAt = Date.now();

    let released = false;
    return {
      signal: controller.signal,
      requestId,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (runtime.currentRun === controller) {
          runtime.currentRun = undefined;
          runtime.currentRequestId = undefined;
        }
      },
    };
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.currentRun?.abort(reason);
    runtime.currentRun = undefined;
    runtime.currentRequestId = undefined;
  }

  /**
   * 清空指定 session 的历史与运行期状态（不清除 Session 本身）。
   *
   * 按 detailed-design §9.1：`cancel` 不清空 history；`clear(sessionId)` 在 close 前重置
   * RuntimeState 与 ContextWindow。此处仅清空 SessionManager 内维护的 history 与
   * runtimeState 标记位，实际 ContextWindow 由 MemorySystem 负责。
   */
  async clear(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.currentRun?.abort("session-clear");
    runtime.currentRun = undefined;
    runtime.currentRequestId = undefined;
    runtime.history = [];
    runtime.runtimeState.clear();
    runtime.session.lastActiveAt = Date.now();
  }
}

