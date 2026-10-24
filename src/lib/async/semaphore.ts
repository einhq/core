/**
 * Counting semaphore with a priority-ordered waiter queue.
 *
 * Caps concurrent access to N permits. `acquire` resolves immediately while
 * permits remain, otherwise parks the caller until a permit is released to it.
 * No busy-loop — waiters are resolved directly by `release`.
 *
 * Waiters are served highest `priority` first, and FIFO within a priority, so the
 * default (everything at 0) behaves exactly like a plain FIFO semaphore.
 *
 * The ordering matters when one workload can flood the other: a burst of cheap jobs
 * that arrives first would otherwise hold every permit while more valuable work waits
 * behind it in arrival order. Note this is *not* pre-emption — a running step keeps its
 * permit until it finishes; priority only decides who gets the next freed one.
 */
export class Semaphore {
  private available_: number;
  private queue: { priority: number; seq: number; resolve: () => void }[] = [];
  /** Monotonic tiebreaker so equal priorities stay FIFO. */
  private seq = 0;

  constructor(permits: number) {
    if (permits < 1) {
      throw new Error('semaphore needs at least 1 permit');
    }
    this.available_ = permits;
  }

  /** Number of permits currently free. */
  get available(): number {
    return this.available_;
  }

  /** Number of callers currently parked waiting for a permit. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Acquire a permit. Higher `priority` is served first when several are parked. */
  async acquire(priority = 0): Promise<void> {
    if (this.available_ > 0) {
      this.available_--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ priority, seq: this.seq++, resolve });
      // Insertion into a small array beats maintaining a heap here: the queue is
      // bounded by the number of in-flight steps, not by total work.
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit straight to the next waiter (count stays consumed).
      next.resolve();
    } else {
      this.available_++;
    }
  }

  async withPermit<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
