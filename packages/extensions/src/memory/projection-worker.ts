import { ProjectionOutbox } from "./projection-outbox";

export interface ProjectionWorkerProjectResult {
  ref: string;
  vectorId: string;
}

export interface ProjectionWorkerOptions {
  outbox: ProjectionOutbox;
  project: (
    sessionId: string,
    refs: readonly string[],
    signal: AbortSignal,
  ) => Promise<ProjectionWorkerProjectResult[] | void>;
  intervalMs?: number | undefined;
}

export interface ProjectionWorkerFlushResult {
  sessions: number;
  projected: number;
  failed: number;
}

export class ProjectionWorker {
  private readonly outbox: ProjectionOutbox;
  private readonly project: ProjectionWorkerOptions["project"];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private abortController: AbortController | undefined;
  private running = false;

  constructor(options: ProjectionWorkerOptions) {
    this.outbox = options.outbox;
    this.project = options.project;
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.abortController = new AbortController();
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
 // Individual projection failures are recorded in the outbox.
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController?.abort();
    this.abortController = undefined;
  }

  async flush(sessionId?: string): Promise<ProjectionWorkerFlushResult> {
    if (this.running) {
      return { sessions: 0, projected: 0, failed: 0 };
    }
    this.running = true;
    try {
      const signal = this.abortController?.signal ?? new AbortController().signal;
      const sessions = sessionId !== undefined ? [sessionId] : await this.outbox.listSessions();
      let touchedSessions = 0;
      let projected = 0;
      let failed = 0;

      for (const sid of sessions) {
        await this.outbox.recover(sid);
        const pending = await this.outbox.listPending(sid);
        if (pending.length === 0) continue;
        touchedSessions += 1;
        const refs = pending.map((record) => record.ref);
        for (const ref of refs) {
          await this.outbox.markRetrying(sid, ref);
        }
        try {
          const result = await this.project(sid, refs, signal);
          const vectorIds = new Map(
            (result ?? refs.map((ref) => ({ ref, vectorId: `${sid}-${ref}` }))).map((item) => [
              item.ref,
              item.vectorId,
            ]),
          );
          for (const ref of refs) {
            const vectorId = vectorIds.get(ref);
            if (vectorId === undefined) {
              failed += 1;
              await this.outbox.markFailed(sid, ref, "projection worker did not return vectorId");
              continue;
            }
            await this.outbox.markIndexed(sid, ref, vectorId);
            projected += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed += refs.length;
          for (const ref of refs) {
            await this.outbox.markFailed(sid, ref, message);
          }
        }
      }

      return { sessions: touchedSessions, projected, failed };
    } finally {
      this.running = false;
    }
  }
}
