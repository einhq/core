/**
 * A `pg` pool that keeps some of itself reachable by interactive work.
 *
 * `node-postgres` hands connections out first-come-first-served, which is the
 * right default while every waiter is equal. Under a crawl they are not: engine
 * steps and pool workers refill the queue continuously, and one interactive
 * command is several *sequential* acquisitions, so it does not wait once, it
 * waits once per acquisition.
 *
 * The answer is a reservation, not a bigger pool. A bigger pool buys
 * throughput; with 40 connections and a crawl willing to use all of them the
 * interactive command still waits behind whatever is already queued.
 *
 * Interactive callers go straight to the driver. Background callers — see
 * `work-class.ts` for who those are and why the default is interactive — pass
 * an admission gate first.
 *
 * ## The rule, and why it takes two conditions
 *
 * A background acquisition is admitted only while both hold:
 *
 *   backgroundInside < max - reserved
 *   backgroundInside + interactiveInside < max
 *
 * where `inside` counts acquisitions that have entered the driver and not yet
 * released — waiting *and* holding. The second condition is the one that is
 * easy to leave out and the one that matters. Cap only what background *holds*
 * and it can still park an unbounded number of waiters in the driver's own FIFO
 * ahead of the next interactive acquisition, which puts it behind them all the
 * same, one level down. With both, an interactive `connect()` finds
 * either a free connection or a queue holding only other interactive waiters,
 * except in the small window where two admissions cross.
 *
 * `reserved = 0` disables the gate entirely, which is what tests and the
 * harness get unless they ask for otherwise.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { createLogger } from '../../managers/logger/mod.ts';
import { currentWorkClass, type PgWorkClass } from './work-class.ts';

type PriorityPoolConfig = PoolConfig & {
  /**
   * Connections background work may never hold. The remainder is its cap.
   * Zero turns the gate off and makes this a plain `Pool`.
   */
  reserved?: number;
};

/**
 * Safety valve: a background acquisition parked this long is admitted anyway.
 *
 * A background caller can hold one connection while acquiring a second — a
 * checked-out client inside a transaction, while the same step goes on doing
 * VFS work through `pool.query()`. If enough background
 * callers did that at once they would each hold a connection while waiting for
 * one the others are holding, and the gate would be the thing that made it a
 * deadlock rather than a slowdown. With a handful of background tasks against
 * the cap that cannot happen, but "cannot happen" is not a property this file
 * can enforce, and a valve that degrades to first-come-first-served is cheaper
 * than a hang. Long enough that ordinary saturation never reaches it.
 */
const BACKGROUND_WAIT_TIMEOUT_MS = 30_000;

const logger = createLogger('pg-pool');

/** What `poolStats()` reports; drained into `/logs/metrics/runtime` by the sampler. */
export type PriorityPoolStats = {
  max: number;
  reserved: number;
  /** Physical connections the driver currently has open. */
  total: number;
  /** Of those, sitting unused. */
  idle: number;
  /** Acquisitions parked in the driver's own queue. */
  waiting: number;
  /** In the driver (waiting or holding), per class. */
  interactiveInside: number;
  backgroundInside: number;
  /** Background acquisitions parked at the gate, before the driver. */
  backgroundGated: number;
  /**
   * Cumulative, never reset — the sampler differences them.
   *
   * `backgroundWaitMsTotal` is summed per waiter, not per unit of wall time, so
   * sixteen acquisitions parked together for 10 ms add 160 ms. Read it against
   * `backgroundWaits` as a mean wait, never as time the process spent stalled.
   */
  backgroundWaitMsTotal: number;
  backgroundWaits: number;
  /** Times the safety valve fired. Anything but zero is worth reading about. */
  backgroundTimeouts: number;
};

/** The callback form of `Pool.connect`, which `Pool.query()` uses internally. */
type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void;

export class PriorityPool extends Pool {
  private readonly maxConnections: number;
  private readonly reserved: number;

  private inside: Record<PgWorkClass, number> = { interactive: 0, background: 0 };
  private gated: ((admitted: 'granted' | 'timeout') => void)[] = [];
  /**
   * Which class checked a client out. A client is checked out to exactly one
   * caller at a time, so the client is an unambiguous key, and weak so a
   * connection the pool removes takes its entry with it.
   */
  private classOf = new WeakMap<PoolClient, PgWorkClass>();

  private waitMsTotal = 0;
  private waits = 0;
  private timeouts = 0;

  constructor(config: PriorityPoolConfig) {
    super(config);
    this.maxConnections = config.max ?? 10;
    this.reserved = Math.max(0, Math.min(config.reserved ?? 0, this.maxConnections - 1));

    // The event rather than wrapping `client.release`: `Pool.query()` acquires
    // and releases internally, so a wrapper installed on the way out of
    // `connect()` would miss every `pool.query()` caller — which is most
    // registry traffic. `_release` emits this unconditionally, including for a
    // client it is about to discard.
    this.on('release', (_err: Error | undefined, client: PoolClient) => this.settle(client));

    // A client that is not checked out — idle, or being closed after a release — reports a lost
    // connection here, and the driver has already removed it. Unheard, the event is thrown and
    // takes the process down with it; the next acquisition opens a fresh connection anyway.
    this.on('error', (err: Error) => logger.warn('idle connection lost', { error: err.message }));
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    // `Pool.query()` calls the callback form internally, so overriding only the
    // promise form would let every `pool.query()` past the gate.
    if (callback) {
      this.acquire().then(
        (client) => callback(undefined, client, (err) => client.release(err as Error | boolean | undefined)),
        (err) => callback(err as Error, undefined, () => {}),
      );
      return;
    }
    return this.acquire();
  }

  /** A snapshot for the metrics sampler. Cheap enough to call on every tick. */
  poolStats(): PriorityPoolStats {
    return {
      max: this.maxConnections,
      reserved: this.reserved,
      total: this.totalCount,
      idle: this.idleCount,
      waiting: this.waitingCount,
      interactiveInside: this.inside.interactive,
      backgroundInside: this.inside.background,
      backgroundGated: this.gated.length,
      backgroundWaitMsTotal: Math.round(this.waitMsTotal),
      backgroundWaits: this.waits,
      backgroundTimeouts: this.timeouts,
    };
  }

  private canAdmitBackground(): boolean {
    if (this.reserved === 0) return true;
    return this.inside.background < this.maxConnections - this.reserved &&
      this.inside.background + this.inside.interactive < this.maxConnections;
  }

  private async acquire(): Promise<PoolClient> {
    const workClass = currentWorkClass();

    if (workClass === 'background' && !this.canAdmitBackground()) {
      await this.waitForAdmission();
    } else {
      // Counted here, synchronously, so two callers arriving in the same tick
      // cannot both read the gate as open. `release()` grants the same way.
      this.inside[workClass]++;
    }

    let client: PoolClient;
    try {
      client = await super.connect();
    } catch (err) {
      this.inside[workClass]--;
      this.grant();
      throw err;
    }

    this.classOf.set(client, workClass);
    return client;
  }

  /** Park until the gate opens, or until the valve fires. Counts as admitted either way. */
  private waitForAdmission(): Promise<void> {
    const startedAt = performance.now();
    this.waits++;

    return new Promise<void>((resolve) => {
      let settled = false;

      const finish = (how: 'granted' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waitMsTotal += performance.now() - startedAt;
        // The timeout path was never granted a slot by `grant()`, so it takes
        // one for itself — deliberately over the cap, which is the whole point
        // of the valve.
        if (how === 'timeout') {
          this.timeouts++;
          this.inside.background++;
          const index = this.gated.indexOf(finish);
          if (index >= 0) this.gated.splice(index, 1);
        }
        resolve();
      };

      const timer = setTimeout(() => finish('timeout'), BACKGROUND_WAIT_TIMEOUT_MS);
      // Never a reason to keep the process alive for a parked background query.
      try {
        Deno.unrefTimer(timer as unknown as number);
      } catch {
        // Not Deno, or the API moved — the valve still works, it just counts as work.
      }

      this.gated.push(finish);
    });
  }

  /** A client came back: drop its count and hand the slot to whoever is parked. */
  private settle(client: PoolClient): void {
    const workClass = this.classOf.get(client);
    // Not ours: a client released by a path that never went through `acquire()`
    // — the driver releases one itself when an acquisition times out.
    if (workClass === undefined) return;

    this.classOf.delete(client);
    this.inside[workClass]--;
    this.grant();
  }

  private grant(): void {
    while (this.gated.length > 0 && this.canAdmitBackground()) {
      this.inside.background++;
      this.gated.shift()!('granted');
    }
  }
}
