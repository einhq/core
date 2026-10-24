import { Mutex } from './mutex.ts';

type LockRelease = () => void;

export class IdLockManager {
  private locks = new Map<string, Mutex>();

  /** Live entries. Should track concurrent writers, not nodes ever written. */
  get size(): number {
    return this.locks.size;
  }

  /** Get or create mutex */
  private getOrCreate(id: string): Mutex {
    let m = this.locks.get(id);
    if (!m) {
      m = new Mutex();
      m.name = id;
      this.locks.set(id, m);
    }
    return m;
  }

  /**
   * Release, and drop the mutex once nothing holds or wants it.
   *
   * Without this the map would be a permanent record of every node id ever
   * locked — every file, instance, step and derivative a crawl touches — and a
   * VFS write is the hottest path in the system.
   *
   * Safe because release and the eviction below run in one synchronous block:
   * a waiter would have been handed the lock by `release()`, leaving it
   * non-idle. The identity check is belt-and-braces for the case where someone
   * has already installed a replacement.
   */
  private releaseAndPrune(id: string, mutex: Mutex): void {
    mutex.release();

    if (mutex.idle && this.locks.get(id) === mutex) {
      this.locks.delete(id);
    }
  }

  /**
   * Executes fn while holding a lock on every id.
   *
   * The whole set is acquired up front, in sorted order, and nothing is held
   * across calls — so a caller can never be half-way through one set while
   * waiting on another, and a cycle between two callers is impossible. There is
   * deliberately no way to widen the set from inside fn: growing a held set is
   * exactly what reintroduces lock-order deadlock.
   */
  async withLocks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
    const toLock = [...new Set(ids)].sort();
    const releases: LockRelease[] = [];

    try {
      for (const id of toLock) {
        const mutex = this.getOrCreate(id);
        await mutex.acquire();
        releases.push(() => this.releaseAndPrune(id, mutex));
      }
    } catch (err) {
      for (const release of releases.reverse()) release();
      throw err;
    }

    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}
