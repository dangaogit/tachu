export type StickySource = "load_skill_tool" | "user_command" | "auto-promote";

export interface StickyEntry {
  skillName: string;
  addedTurn: number;
  ttlRemaining: number;
  source: StickySource;
}

export interface StickyMarkInput {
  sessionId: string;
  skillName: string;
  source: StickySource;
  currentTurn: number;
}

export interface StickyMarkResult {
  action: "add" | "refresh" | "evict";
  evicted?: StickyEntry;
  entry: StickyEntry;
}

export interface StickyListResult {
  active: StickyEntry[];
  expired: StickyEntry[];
}

export interface StickyManager {
  list(sessionId: string, currentTurn: number): Promise<StickyListResult>;
  mark(input: StickyMarkInput): Promise<StickyMarkResult>;
  clearSession(sessionId: string): Promise<void>;
}

export interface InMemoryStickyManagerOptions {
  ttlTurns?: number;
  maxSlots?: number;
}

interface SessionStickyState {
  entries: StickyEntry[];
}

/**
 * Session 内 in-memory sticky 管理：TTL + slot + LRU。
 */
export class InMemoryStickyManager implements StickyManager {
  private readonly ttlTurns: number;
  private readonly maxSlots: number;
  private readonly sessions = new Map<string, SessionStickyState>();

  constructor(options: InMemoryStickyManagerOptions = {}) {
    this.ttlTurns = options.ttlTurns ?? 8;
    this.maxSlots = options.maxSlots ?? 3;
  }

  async list(sessionId: string, currentTurn: number): Promise<StickyListResult> {
    const state = this.getOrCreate(sessionId);
    const active: StickyEntry[] = [];
    const expired: StickyEntry[] = [];

    for (const entry of state.entries) {
      const age = currentTurn - entry.addedTurn;
      if (age >= this.ttlTurns) {
        expired.push(entry);
      } else {
        active.push({
          ...entry,
          ttlRemaining: this.ttlTurns - age,
        });
      }
    }

    state.entries = active;
    return { active, expired };
  }

  async mark(input: StickyMarkInput): Promise<StickyMarkResult> {
    const state = this.getOrCreate(input.sessionId);
    const existingIndex = state.entries.findIndex((entry) => entry.skillName === input.skillName);

    if (existingIndex >= 0) {
      const existing = state.entries[existingIndex]!;
      const refreshed: StickyEntry = {
        ...existing,
        addedTurn: input.currentTurn,
        source: input.source,
        ttlRemaining: this.ttlTurns,
      };
      state.entries[existingIndex] = refreshed;
      return { action: "refresh", entry: refreshed };
    }

    let evicted: StickyEntry | undefined;
    if (state.entries.length >= this.maxSlots) {
      const sorted = [...state.entries].sort((a, b) => a.addedTurn - b.addedTurn);
      const oldest = sorted[0];
      if (oldest) {
        evicted = oldest;
        state.entries = state.entries.filter((entry) => entry.skillName !== oldest.skillName);
      }
    }

    const entry: StickyEntry = {
      skillName: input.skillName,
      addedTurn: input.currentTurn,
      ttlRemaining: this.ttlTurns,
      source: input.source,
    };
    state.entries.push(entry);

    return {
      action: evicted ? "evict" : "add",
      ...(evicted !== undefined ? { evicted } : {}),
      entry,
    };
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): SessionStickyState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionStickyState = { entries: [] };
    this.sessions.set(sessionId, created);
    return created;
  }
}
