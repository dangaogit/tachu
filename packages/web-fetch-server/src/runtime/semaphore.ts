/**
 * Thrown when {@link Semaphore.acquire} cannot obtain a permit before timeout or when the
 * optional {@link AbortSignal} is aborted.
 */
export class SemaphoreTimeoutError extends Error {
  override readonly name = "SemaphoreTimeoutError";

  constructor(
    message = "Semaphore acquire timed out or was aborted",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  abortCleanup?: () => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

/**
 * In-process FIFO semaphore for limiting concurrent work (e.g. browser renders).
 */
export class Semaphore {
  readonly #maxPermits: number;
  #available: number;
  readonly #waiters: Waiter[] = [];

  constructor(options: { permits: number }) {
    const { permits } = options;
    if (!Number.isFinite(permits) || !Number.isInteger(permits) || permits < 1) {
      throw new RangeError("Semaphore permits must be a positive integer");
    }
    this.#maxPermits = permits;
    this.#available = permits;
  }

  /**
   * Acquire one permit. Resolves to a **release** callback; call it exactly once when done.
   * The release callback is idempotent — calling it more than once has no effect.
   *
   * @param signal - When aborted, rejects with {@link SemaphoreTimeoutError}.
   * @param timeoutMs - When non-negative, rejects if not acquired within this many milliseconds.
   */
  acquire(signal?: AbortSignal, timeoutMs?: number): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        new SemaphoreTimeoutError("Semaphore acquire aborted", { cause: signal.reason }),
      );
    }

    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve(this.#createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };

      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#removeWaiter(waiter);
          reject(
            new SemaphoreTimeoutError("Semaphore acquire aborted", {
              cause: signal.reason,
            }),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.abortCleanup = (): void => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      if (timeoutMs !== undefined && timeoutMs >= 0) {
        waiter.timeoutId = setTimeout((): void => {
          this.#removeWaiter(waiter);
          reject(new SemaphoreTimeoutError("Semaphore acquire timed out"));
        }, timeoutMs);
      }

      this.#waiters.push(waiter);
    });
  }

  /**
   * Current occupancy and queue depth for metrics.
   */
  stats(): { inflight: number; waiting: number } {
    return {
      inflight: this.#maxPermits - this.#available,
      waiting: this.#waiters.length,
    };
  }

  #createRelease(): () => void {
    let done = false;
    return (): void => {
      if (done) {
        return;
      }
      done = true;
      this.#releaseOne();
    };
  }

  #releaseOne(): void {
    if (this.#waiters.length > 0) {
      const next = this.#waiters.shift()!;
      this.#finalizeWaiter(next);
      next.resolve(this.#createRelease());
      return;
    }
    this.#available++;
  }

  #finalizeWaiter(waiter: Waiter): void {
    waiter.abortCleanup?.();
    if (waiter.timeoutId !== undefined) {
      clearTimeout(waiter.timeoutId);
    }
  }

  #removeWaiter(waiter: Waiter): void {
    const i = this.#waiters.indexOf(waiter);
    if (i === -1) {
      return;
    }
    this.#waiters.splice(i, 1);
    this.#finalizeWaiter(waiter);
  }
}
