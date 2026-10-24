import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('mutex');
const DEBUG_LOCKS = Deno.env.get('DEBUG_LOCKS') === '1';
const LOCK_WARN_MS = 5000;

export class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];
  private holder?: string;
  private heldSince?: number;
  private warnTimer?: ReturnType<typeof setTimeout>;
  name?: string;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      if (DEBUG_LOCKS) this.trackHolder();
      return;
    }

    if (DEBUG_LOCKS) {
      const waiter = new Error().stack;
      logger.warn(
        `waiting for lock${this.name ? ` "${this.name}"` : ''}, held by:\n${this.holder}`,
      );
      logger.debug(`waiter stack:\n${waiter}`);
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        if (DEBUG_LOCKS) this.trackHolder();
        resolve();
      });
    });
  }

  release(): void {
    if (!this.locked) {
      throw new Error('mutex released while not locked');
    }

    if (DEBUG_LOCKS) {
      clearTimeout(this.warnTimer);
      const held = this.heldSince ? performance.now() - this.heldSince : 0;
      if (held > LOCK_WARN_MS) {
        logger.warn(
          `lock${this.name ? ` "${this.name}"` : ''} held for ${(held / 1000).toFixed(1)}s`,
        );
      }
      this.holder = undefined;
      this.heldSince = undefined;
    }

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.locked = true;
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Nothing holds this and nothing is queued for it, so a keyed owner can drop
   * it without anyone losing exclusion. Checked synchronously right after a
   * release, where no other task can have interleaved.
   */
  get idle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private trackHolder(): void {
    this.holder = new Error().stack;
    this.heldSince = performance.now();
    this.warnTimer = setTimeout(() => {
      logger.warn(
        `lock${this.name ? ` "${this.name}"` : ''} held for >${LOCK_WARN_MS / 1000}s, holder:\n${this.holder}`,
      );
      logger.warn(`queue depth: ${this.queue.length}`);
    }, LOCK_WARN_MS);
  }
}
