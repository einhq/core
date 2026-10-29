import { Pool, PoolClient } from 'pg';
import { ensureResource, ResourceMode } from '../types.ts';
import { resolvePolicy, tallyCounts, validateVector } from './lib.ts';
import { PoolHandle } from './pool-handle.ts';
import {
  PoolClaimRequest,
  PoolCounts,
  PoolFailOptions,
  PoolIO,
  PoolJob,
  PoolJobFilter,
  PoolJobId,
  PoolJobInput,
  PoolJobSelector,
  PoolJobState,
  PoolPurgeOptions,
  PoolRegistryIf,
  PoolResourceOptions,
  PoolStat,
  PoolSweepResult,
} from './types.ts';

type PgPoolRegistryConfig = {
  pool: Pool;
  name: string;
  /**
   * Pool the LISTEN connection comes from. Defaults to `pool`.
   *
   * The notification client is held for this registry's whole lifetime and can
   * never serve a query, so taking it from the work pool is a permanent
   * subtraction from it.
   */
  listenPool?: Pool;
};

/** Safety-net poll behind a blocking claim. See the note in `claim`. */
const POLL_MS = 1000;

/** Jobs promoted per aging sweep, so one sweep cannot stall on a huge backlog. */
const AGING_BATCH = 1000;

/** Jobs deleted per statement by `purge`. */
const PURGE_BATCH = 5000;

/**
 * Rows each (pool, kind, state) count is spread over. A writer adds to the row
 * of its backend, so concurrent claims rarely wait on one counter row.
 */
const COUNT_SLOTS = 16;

/** Unique violation — a concurrent claimer won the exclusivity class. */
const UNIQUE_VIOLATION = '23505';

type JobRow = {
  id: string;
  pool_id: string;
  kind: string;
  state: PoolJobState;
  priority: number;
  eff_priority: number;
  requires: Record<string, number>;
  params: unknown;
  dedup_key: string | null;
  exclusive: string | null;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  claimed_at: Date | null;
  finished_at: Date | null;
  result: unknown;
  error: string | null;
};

/**
 * PostgreSQL work pool.
 *
 * The scheduling key is the stored `eff_priority` column rather than an
 * expression over `now()`: an aging term computed in the ORDER BY would not be
 * immutable, so no index could satisfy the sort and every claim would read and
 * heapsort the entire ready backlog. Aging is applied in discrete buckets by
 * {@link sweep} instead, which keeps the claim an ordered index scan that stops
 * at the first matching row.
 *
 * See `README.md` for the model; `MemoryPoolRegistry` is the reference
 * implementation of the same semantics and the conformance suite runs on both.
 */
export class PgPoolRegistry implements PoolRegistryIf {
  private initialized = false;
  private pool: Pool;
  private listenPool: Pool;
  private tablePrefix: string;

  // Shared LISTEN connection — one connection for all waiters.
  private listenerConn?: PoolClient;
  private listenerReady?: Promise<void>;
  private listeners = new Map<string, Set<() => void>>();
  /** Per pool, so a busy pool's sweep cadence cannot starve a quiet one's. */
  private lastSweep = new Map<string, number>();

  constructor(protected config: PgPoolRegistryConfig) {
    const name = `${config.name}_pools`;

    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table prefix: ${name}`);
    }

    this.tablePrefix = name;
    this.pool = config.pool;
    this.listenPool = config.listenPool ?? config.pool;
  }

  private get poolsTable(): string {
    return this.tablePrefix;
  }

  private get jobsTable(): string {
    return `${this.tablePrefix}_job`;
  }

  /** Jobs per (pool, kind, state), purged ones included; see {@link tally}. */
  private get countTable(): string {
    return `${this.tablePrefix}_count`;
  }

  private get jobsChannel(): string {
    return `${this.tablePrefix}_job_com`;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.createSchema();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.resetListener();
    this.listeners.clear();
  }

  async touch(id: string, opts: PoolResourceOptions): Promise<boolean> {
    const p = resolvePolicy(opts);

    const result = await this.pool.query(
      `
      INSERT INTO ${this.poolsTable}
        (id, aging_seconds, aging_boost, aging_max, lease_ms, max_attempts, backoff_ms, backoff_max_ms, sweep_interval_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE
        SET aging_seconds = EXCLUDED.aging_seconds,
            aging_boost = EXCLUDED.aging_boost,
            aging_max = EXCLUDED.aging_max,
            lease_ms = EXCLUDED.lease_ms,
            max_attempts = EXCLUDED.max_attempts,
            backoff_ms = EXCLUDED.backoff_ms,
            backoff_max_ms = EXCLUDED.backoff_max_ms,
            sweep_interval_ms = EXCLUDED.sweep_interval_ms
      WHERE (${this.poolsTable}.aging_seconds, ${this.poolsTable}.aging_boost, ${this.poolsTable}.aging_max,
             ${this.poolsTable}.lease_ms, ${this.poolsTable}.max_attempts, ${this.poolsTable}.backoff_ms,
             ${this.poolsTable}.backoff_max_ms, ${this.poolsTable}.sweep_interval_ms)
        IS DISTINCT FROM
            (EXCLUDED.aging_seconds, EXCLUDED.aging_boost, EXCLUDED.aging_max,
             EXCLUDED.lease_ms, EXCLUDED.max_attempts, EXCLUDED.backoff_ms,
             EXCLUDED.backoff_max_ms, EXCLUDED.sweep_interval_ms)
      `,
      [id, p.agingSeconds, p.agingBoost, p.agingMax, p.leaseMs, p.maxAttempts, p.backoffMs, p.backoffMaxMs, p.sweepIntervalMs],
    );

    return result.rowCount === 1;
  }

  async open(id: string, opts: PoolResourceOptions, mode?: ResourceMode): Promise<PoolHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      // A purge's delete leaves the counts alone; this one takes the jobs out of them.
      await this.pool.query(
        `
        WITH del AS (DELETE FROM ${this.jobsTable} WHERE pool_id = $1 RETURNING kind, state)
        INSERT INTO ${this.countTable} (pool_id, kind, state, slot, n)
        SELECT $1, kind, state, pg_backend_pid() % ${COUNT_SLOTS}, -COUNT(*) FROM del
         GROUP BY kind, state ORDER BY kind, state
        ON CONFLICT (pool_id, kind, state, slot) DO UPDATE SET n = ${this.countTable}.n + EXCLUDED.n
        `,
        [id],
      );
    }

    const io: PoolIO = {
      page: (afterId, limit) => this.jobs(id, { state: 'ready', afterId, limit }),
      add: (job) => this.add(id, job),
    };

    const handle = new PoolHandle(id, opts, mode || 'r', this, io);
    await handle.init();

    return handle;
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM ${this.poolsTable} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async stat(id: string): Promise<PoolStat> {
    const result = await this.pool.query<{
      aging_seconds: number;
      aging_boost: number;
      aging_max: number;
      lease_ms: string;
      max_attempts: number;
      backoff_ms: string;
      backoff_max_ms: string;
      sweep_interval_ms: string;
    }>(`SELECT * FROM ${this.poolsTable} WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      throw new Error(`no pool found: ${id}`);
    }

    const row = result.rows[0];
    const { counts, byKind, oldestReadyAt } = await this.tally(id);

    return {
      size: counts.ready,
      counts,
      byKind,
      oldestReadyAt,
      agingSeconds: Number(row.aging_seconds),
      agingBoost: Number(row.aging_boost),
      agingMax: Number(row.aging_max),
      leaseMs: Number(row.lease_ms),
      maxAttempts: Number(row.max_attempts),
      backoffMs: Number(row.backoff_ms),
      backoffMaxMs: Number(row.backoff_max_ms),
      sweepIntervalMs: Number(row.sweep_interval_ms),
    };
  }

  async statX(id: string): Promise<PoolStat> {
    return await this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    // Jobs cascade, so there is no orphan sweep to run afterwards.
    const result = await this.pool.query(`DELETE FROM ${this.poolsTable} WHERE id = $1`, [id]);
    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      this.notifyLocal(id);
    }

    return deleted;
  }

  async list(): Promise<AsyncIterable<string>> {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM ${this.poolsTable} ORDER BY id`);
    const ids = result.rows.map((row) => row.id);

    return (async function* () {
      for (const id of ids) {
        yield id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${this.poolsTable}`);
    return Number(result.rows[0]?.count ?? '0');
  }

  // ===== Pool operations =====

  async add(id: string, input: PoolJobInput): Promise<PoolJob> {
    if (!input.kind) {
      throw new Error('job kind is required');
    }

    const requires = validateVector(input.requires, 'requires');
    const priority = input.priority ?? 0;

    // The partial unique index is the arbiter, so re-adding a live dedup key
    // updates that job instead of appending a duplicate nobody will reap — and
    // only when the re-add raises its priority or brings it forward. Otherwise
    // nothing is written and the job is read back as it is: a crawl re-announces
    // waiting work over and over, and an update that changed nothing was still a
    // row version, WAL and a commit each time (ein/core#510).
    const upsert = () =>
      this.pool.query<JobRow>(
        `
        WITH upsert AS (
          INSERT INTO ${this.jobsTable}
            (pool_id, kind, priority, eff_priority, requires, params, dedup_key, exclusive, max_attempts, available_at, attempts)
          VALUES ($1::varchar, $2::text, $3::int, $3::int, $4::jsonb, $5::jsonb, $6::text, $7::text,
                  COALESCE($8::int, (SELECT max_attempts FROM ${this.poolsTable} WHERE id = $1::varchar)),
                  now() + ($9::bigint * interval '1 millisecond'), $10::int)
          ON CONFLICT (pool_id, dedup_key) WHERE dedup_key IS NOT NULL AND state IN ('ready','claimed')
          DO UPDATE SET priority = GREATEST(${this.jobsTable}.priority, EXCLUDED.priority),
                        eff_priority = GREATEST(${this.jobsTable}.eff_priority, EXCLUDED.priority),
                        available_at = LEAST(${this.jobsTable}.available_at, EXCLUDED.available_at)
          WHERE ${this.jobsTable}.priority < EXCLUDED.priority
             OR ${this.jobsTable}.eff_priority < EXCLUDED.priority
             OR ${this.jobsTable}.available_at > EXCLUDED.available_at
          RETURNING *
        )
        SELECT * FROM upsert
        UNION ALL
        SELECT * FROM ${this.jobsTable}
         WHERE NOT EXISTS (SELECT 1 FROM upsert)
           AND pool_id = $1::varchar AND dedup_key = $6::text AND state IN ('ready','claimed')
        `,
        [
          id,
          input.kind,
          priority,
          JSON.stringify(requires),
          JSON.stringify(input.params ?? null),
          input.dedupKey ?? null,
          input.exclusive ?? null,
          input.maxAttempts ?? null,
          input.delayMs ?? 0,
          Math.max(0, Math.floor(input.attempts ?? 0)),
        ],
      );

    // No row comes back in two cases. Without the pool row, the max_attempts subquery yields
    // NULL and nothing is inserted. Or the add lost a race: another connection committed a live
    // job with the same dedup key after this statement began, which the conflict check sees and
    // the statement's snapshot, read by the fallback, does not. A new statement sees that job,
    // or inserts if it has finished since (ein/core#739).
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await upsert();
      if (result.rows.length > 0) {
        return toJob(result.rows[0]);
      }
      if (!(await this.exists(id))) {
        throw new Error(`no pool found: ${id}`);
      }
    }
    throw new Error(`pool ${id}: the job for dedup key ${input.dedupKey} kept changing under the add`);
  }

  async claim(id: string, req: PoolClaimRequest, signal?: AbortSignal): Promise<PoolJob | null> {
    validateVector(req.offer, 'offer');

    if (!(await this.exists(id))) {
      throw new Error(`no pool found: ${id}`);
    }

    await this.sweepIfDue(id);

    const immediate = await this.tryClaim(id, req);

    if (immediate || !signal) {
      return immediate;
    }

    // Blocking. Two things differ from a queue's blocking read, and both push
    // work onto the poll rather than the notification:
    //
    //  - a NOTIFY does not mean *this* waiter can claim; the job may not match
    //    the offer, or its exclusivity class may be held.
    //  - a job can become claimable with no row change at all — `available_at`
    //    passing, or a lease lapsing — so there is nothing to trigger on.
    //
    // POLL_MS is therefore the upper bound on scheduling latency for time-based
    // eligibility, not merely a lost-notification backstop. As in the queue, a
    // transient error must never resolve null: consumers read null as EOF.
    await this.ensureListener().catch(() => {});

    return await new Promise<PoolJob | null>((resolve) => {
      let settled = false;
      let polling = false;
      let timer: ReturnType<typeof setInterval> | undefined = undefined;

      const settle = (value: PoolJob | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const attempt = async () => {
        // Serialize this waiter's polls so a NOTIFY and a timer tick cannot both
        // claim (the loser's job would be leased to nobody until it expired).
        if (settled || polling) return;
        polling = true;

        try {
          await this.sweepIfDue(id);
          const job = await this.tryClaim(id, req);

          if (job) {
            settle(job);
          }
        } catch {
          // Transient error — drop the possibly dead listener so it reconnects
          // and let the poll retry. Never resolve here.
          this.resetListener();
          void this.ensureListener().catch(() => {});
        } finally {
          polling = false;
        }
      };

      const onAbort = () => settle(null);
      const removeListener = this.addListener(id, () => void attempt());

      const cleanup = () => {
        if (timer !== undefined) clearInterval(timer);
        removeListener();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
        return;
      }

      timer = setInterval(() => void attempt(), POLL_MS);
      void attempt();
    });
  }

  async heartbeat(id: string, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE ${this.jobsTable} j
         SET lease_until = now() + (COALESCE($4::bigint, p.lease_ms) * interval '1 millisecond')
        FROM ${this.poolsTable} p
       WHERE p.id = j.pool_id
         AND j.id = $1 AND j.pool_id = $2 AND j.lease_owner = $3 AND j.state = 'claimed'
      `,
      [jobId, id, owner, leaseMs ?? null],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async complete(id: string, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null> {
    const res = await this.pool.query<JobRow>(
      `
      UPDATE ${this.jobsTable}
         SET state = 'done', finished_at = now(), result = $4::jsonb,
             lease_owner = NULL, lease_until = NULL
       WHERE id = $1 AND pool_id = $2 AND lease_owner = $3 AND state = 'claimed'
      RETURNING *
      `,
      [jobId, id, owner, JSON.stringify(result ?? null)],
    );

    return res.rows.length > 0 ? toJob(res.rows[0]) : null;
  }

  async fail(id: string, jobId: PoolJobId, owner: string, error: string, opts: PoolFailOptions = {}): Promise<PoolJob | null> {
    const res = await this.pool.query<JobRow>(
      `
      UPDATE ${this.jobsTable} j
         SET state = CASE WHEN $5::boolean OR j.attempts >= j.max_attempts THEN 'failed' ELSE 'ready' END,
             error = $4,
             lease_owner = NULL, lease_until = NULL, claimed_at = NULL,
             finished_at = CASE WHEN $5::boolean OR j.attempts >= j.max_attempts THEN now() ELSE NULL END,
             available_at = CASE
               WHEN $5::boolean OR j.attempts >= j.max_attempts THEN j.available_at
               ELSE now() + (LEAST(p.backoff_max_ms, p.backoff_ms * power(2, LEAST(j.attempts, 16))::bigint)
                             * interval '1 millisecond')
             END
        FROM ${this.poolsTable} p
       WHERE p.id = j.pool_id
         AND j.id = $1 AND j.pool_id = $2 AND j.lease_owner = $3 AND j.state = 'claimed'
      RETURNING j.*
      `,
      [jobId, id, owner, error, opts.terminal === true],
    );

    return res.rows.length > 0 ? toJob(res.rows[0]) : null;
  }

  async release(id: string, jobId: PoolJobId, owner: string, delayMs = 0): Promise<PoolJob | null> {
    const res = await this.pool.query<JobRow>(
      `
      UPDATE ${this.jobsTable}
         SET state = 'ready', attempts = GREATEST(attempts - 1, 0),
             available_at = now() + ($4::bigint * interval '1 millisecond'),
             lease_owner = NULL, lease_until = NULL, claimed_at = NULL
       WHERE id = $1 AND pool_id = $2 AND lease_owner = $3 AND state = 'claimed'
      RETURNING *
      `,
      [jobId, id, owner, Math.max(0, Math.round(delayMs))],
    );

    return res.rows.length > 0 ? toJob(res.rows[0]) : null;
  }

  async cancel(id: string, sel: PoolJobSelector): Promise<number> {
    const [predicate, value] = selectorSql(sel);

    const result = await this.pool.query(
      `
      UPDATE ${this.jobsTable}
         SET state = 'cancelled', finished_at = now(), lease_owner = NULL, lease_until = NULL
       WHERE pool_id = $1 AND state IN ('ready','claimed') AND ${predicate}
      `,
      [id, value],
    );

    return result.rowCount ?? 0;
  }

  async retry(id: string, sel: PoolJobSelector): Promise<number> {
    const [predicate, value] = selectorSql(sel);

    // A retry is a fresh start, not a resumption: leaving `attempts` alone would
    // let the next sweep reclaim an exhausted job straight back to failed.
    const result = await this.pool.query(
      `
      UPDATE ${this.jobsTable}
         SET state = 'ready', attempts = 0, available_at = now(),
             finished_at = NULL, error = NULL, result = NULL,
             lease_owner = NULL, lease_until = NULL, claimed_at = NULL
       WHERE pool_id = $1 AND state IN ('done','failed','cancelled') AND ${predicate}
      `,
      [id, value],
    );

    return result.rowCount ?? 0;
  }

  /**
   * Delete terminal jobs in batches.
   *
   * Batched by ascending id so each batch is a short transaction of its own: a
   * first purge after a backlog once deleted 780k rows in one statement and held
   * it for minutes under a crawl. Old jobs have low ids, so the batches find them
   * first. Deletes do not change the counts, so `done` and `failed` in
   * {@link stat} never fall, which is what makes them usable as rates.
   */
  async purge(id: string, opts?: PoolPurgeOptions): Promise<number> {
    const states = opts?.state === undefined ? ['done', 'failed', 'cancelled'] : Array.isArray(opts.state) ? opts.state : [opts.state];

    let total = 0;
    let after = 0;
    for (;;) {
      const result = await this.pool.query<{ n: number; last: string | null }>(
        `
        WITH del AS (
          DELETE FROM ${this.jobsTable}
           WHERE id IN (
             SELECT id FROM ${this.jobsTable}
              WHERE pool_id = $1
                AND state = ANY($2::text[])
                AND ($3::bigint IS NULL OR finished_at <= now() - ($3::bigint * interval '1 millisecond'))
                AND id > $4
              ORDER BY id
              LIMIT $5
           )
          RETURNING id
        )
        SELECT COUNT(*)::int AS n, MAX(id) AS last FROM del
        `,
        [id, states, opts?.olderThanMs ?? null, after, PURGE_BATCH],
      );

      const { n, last } = result.rows[0];
      total += n;
      if (n < PURGE_BATCH || last === null) return total;
      after = Number(last);
    }
  }

  async get(id: string, jobId: PoolJobId): Promise<PoolJob | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM ${this.jobsTable} WHERE id = $1 AND pool_id = $2`,
      [jobId, id],
    );

    return result.rows.length > 0 ? toJob(result.rows[0]) : null;
  }

  async jobs(id: string, filter?: PoolJobFilter): Promise<PoolJob[]> {
    const states = filter?.state === undefined ? undefined : Array.isArray(filter.state) ? filter.state : [filter.state];

    const result = await this.pool.query<JobRow>(
      `
      SELECT * FROM ${this.jobsTable}
       WHERE pool_id = $1
         AND ($2::text[] IS NULL OR state = ANY($2::text[]))
         AND ($3::text IS NULL OR kind = $3)
         AND ($4::bigint IS NULL OR id > $4)
         AND ($6::text IS NULL OR dedup_key = $6)
       ORDER BY id
       LIMIT $5
      `,
      [id, states ?? null, filter?.kind ?? null, filter?.afterId ?? null, filter?.limit ?? null, filter?.dedupKey ?? null],
    );

    return result.rows.map(toJob);
  }

  async counts(id: string): Promise<PoolCounts> {
    return (await this.tally(id)).counts;
  }

  /**
   * Jobs per kind and state, purged ones included, and the oldest ready job of each kind.
   *
   * The counts are kept by the triggers on the jobs table, so this reads at most
   * {@link COUNT_SLOTS} rows per kind and state however many jobs the pool holds.
   */
  private async tally(id: string): Promise<ReturnType<typeof tallyCounts>> {
    const result = await this.pool.query<{ kind: string; state: PoolJobState; count: string; oldest: Date | null }>(
      `
      WITH c AS (
        SELECT kind, state, SUM(n) AS count FROM ${this.countTable} WHERE pool_id = $1
         GROUP BY kind, state HAVING SUM(n) <> 0
      )
      SELECT kind, state, count,
             CASE WHEN state = 'ready' THEN (
               SELECT MIN(created_at) FROM ${this.jobsTable} j
                WHERE j.pool_id = $1 AND j.kind = c.kind AND j.state = 'ready'
             ) END AS oldest
        FROM c
      `,
      [id],
    );

    return tallyCounts(result.rows.map((row) => ({
      kind: row.kind,
      state: row.state,
      count: Number(row.count),
      oldestAt: row.oldest ? new Date(row.oldest).getTime() : undefined,
    })));
  }

  async sweep(id?: string): Promise<PoolSweepResult> {
    const scope = id ?? null;

    // 1. Dead lease with no attempts left: terminal.
    const failed = await this.pool.query(
      `
      UPDATE ${this.jobsTable}
         SET state = 'failed', finished_at = now(), lease_owner = NULL, lease_until = NULL,
             error = COALESCE(error, 'lease expired after ' || attempts || ' attempts')
       WHERE state = 'claimed' AND lease_until < now() AND attempts >= max_attempts
         AND ($1::text IS NULL OR pool_id = $1)
      `,
      [scope],
    );

    // 2. Dead lease with attempts left: back to ready, backed off.
    const reclaimed = await this.pool.query(
      `
      UPDATE ${this.jobsTable} j
         SET state = 'ready', lease_owner = NULL, lease_until = NULL, claimed_at = NULL,
             available_at = now() + (LEAST(p.backoff_max_ms, p.backoff_ms * power(2, LEAST(j.attempts, 16))::bigint)
                                     * interval '1 millisecond')
        FROM ${this.poolsTable} p
       WHERE p.id = j.pool_id AND j.state = 'claimed' AND j.lease_until < now()
         AND ($1::text IS NULL OR j.pool_id = $1)
      `,
      [scope],
    );

    // 3. Aging: promote each due job exactly one bucket. A job at level n is due
    //    once it is older than (n+1) * aging_seconds, so promotion is monotone
    //    and order-preserving — an older job reaches every level first.
    const promoted = await this.pool.query(
      `
      WITH due AS (
        SELECT j.id, p.aging_boost, p.aging_max, j.priority
          FROM ${this.jobsTable} j JOIN ${this.poolsTable} p ON p.id = j.pool_id
         WHERE j.state = 'ready'
           AND p.aging_seconds > 0
           AND j.eff_priority < j.priority + p.aging_max
           AND j.created_at <= now() - (p.aging_seconds
                 * ((j.eff_priority - j.priority) / GREATEST(p.aging_boost, 1) + 1)
                 * interval '1 second')
           AND ($1::text IS NULL OR j.pool_id = $1)
         ORDER BY j.created_at
         LIMIT ${AGING_BATCH}
      )
      UPDATE ${this.jobsTable} j
         SET eff_priority = LEAST(j.eff_priority + due.aging_boost, due.priority + due.aging_max)
        FROM due WHERE due.id = j.id
      `,
      [scope],
    );

    if (id !== undefined) {
      this.lastSweep.set(id, Date.now());
    }

    return {
      reclaimed: reclaimed.rowCount ?? 0,
      failed: failed.rowCount ?? 0,
      promoted: promoted.rowCount ?? 0,
    };
  }

  // ===== Internals =====

  /**
   * Opportunistic maintenance, throttled to the pool's `sweepIntervalMs`. This
   * is why there is no reaper process: every claim path already passes here, and
   * the engine holds a registry even when no worker is attached.
   */
  private async sweepIfDue(id: string): Promise<void> {
    const now = Date.now();
    const last = this.lastSweep.get(id) ?? 0;

    if (now - last < await this.sweepInterval(id)) {
      return;
    }

    // Claim the slot before awaiting, so concurrent callers don't all sweep.
    this.lastSweep.set(id, now);

    try {
      await this.sweep(id);
    } catch {
      // Maintenance is best-effort; the claim itself still runs.
    }
  }

  private async sweepInterval(id: string): Promise<number> {
    const result = await this.pool.query<{ sweep_interval_ms: string }>(
      `SELECT sweep_interval_ms FROM ${this.poolsTable} WHERE id = $1`,
      [id],
    );

    return Number(result.rows[0]?.sweep_interval_ms ?? 30_000);
  }

  private async tryClaim(id: string, req: PoolClaimRequest): Promise<PoolJob | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.claimOnce(id, req);
      } catch (err) {
        // A concurrent claimer took the same exclusivity class between our
        // NOT EXISTS check and the insert of its lease. The unique index is the
        // real guarantee; retry once to pick the next eligible job.
        if (isUniqueViolation(err) && attempt === 0) {
          continue;
        }

        throw err;
      }
    }

    return null;
  }

  private async claimOnce(id: string, req: PoolClaimRequest): Promise<PoolJob | null> {
    // A scalar equality lets the planner use the kind-scoped index and stop at
    // the first row. `= ANY` cannot provide the sort order, so it falls back to
    // the pool-wide index and filters — still correct and still ordered, but it
    // walks the non-matching head. Cheap next to any real step.
    const kinds = req.kinds && req.kinds.length > 0 ? req.kinds : null;
    const [kindPredicate, kindParam] = kinds === null
      ? ['($4::text IS NULL)', null]
      : kinds.length === 1
      ? ['c.kind = $4::text', kinds[0]]
      : [`c.kind = ANY($4::text[])`, kinds];

    const result = await this.pool.query<JobRow>(
      `
      UPDATE ${this.jobsTable} j
         SET state = 'claimed', lease_owner = $2, claimed_at = now(), attempts = j.attempts + 1,
             lease_until = now() + (COALESCE($3::bigint, p.lease_ms) * interval '1 millisecond')
        FROM ${this.poolsTable} p
       WHERE p.id = j.pool_id
         AND j.id = (
           SELECT c.id FROM ${this.jobsTable} c
            WHERE c.pool_id = $1
              AND c.state = 'ready'
              AND c.available_at <= now()
              AND ${kindPredicate}
              -- requires[k] <= offer[k] for every k. jsonb_each is an implicit
              -- LATERAL over the outer row. jsonb_typeof guards the cast, so a
              -- malformed value makes THAT job unclaimable rather than raising
              -- and poisoning every claim on the pool.
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_each(c.requires) AS r(key, value)
                 WHERE jsonb_typeof(r.value) <> 'number'
                    OR (r.value #>> '{}')::numeric > COALESCE(($5::jsonb -> r.key) #>> '{}', '0')::numeric
              )
              -- Mutex class free? An expired-but-unswept lease still holds it:
              -- fail-safe, and consistent with the unique index, which cannot
              -- reference now().
              AND (c.exclusive IS NULL OR NOT EXISTS (
                SELECT 1 FROM ${this.jobsTable} x
                 WHERE x.pool_id = c.pool_id AND x.exclusive = c.exclusive AND x.state = 'claimed'
              ))
            ORDER BY c.eff_priority DESC, c.created_at ASC, c.id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
      RETURNING j.*
      `,
      [id, req.owner, req.leaseMs ?? null, kindParam, JSON.stringify(req.offer ?? {})],
    );

    return result.rows.length > 0 ? toJob(result.rows[0]) : null;
  }

  private ensureListener(): Promise<void> {
    if (this.listenerReady) return this.listenerReady;

    this.listenerReady = (async () => {
      const conn = await this.listenPool.connect();

      conn.on('notification', (msg) => {
        if (msg.channel !== this.jobsChannel) return;
        const poolId = msg.payload;
        if (!poolId) return;
        this.notifyLocal(poolId);
      });

      // The LISTEN connection can drop (e.g. Postgres restart). Drop it so the
      // next ensureListener reconnects; waiters keep progressing via the poll.
      conn.on('error', () => this.resetListener());
      await conn.query(`LISTEN ${this.jobsChannel}`);
      this.listenerConn = conn;
    })().catch((err) => {
      // Don't cache a rejected promise — reconnect on the next call.
      this.listenerReady = undefined;
      throw err;
    });

    return this.listenerReady;
  }

  private resetListener(): void {
    const conn = this.listenerConn;
    this.listenerConn = undefined;
    this.listenerReady = undefined;

    if (conn) {
      try {
        conn.removeAllListeners('notification');
        conn.removeAllListeners('error');
        conn.release(true); // destroy — the connection may be broken
      } catch {
        // ignore
      }
    }
  }

  private addListener(poolId: string, callback: () => void): () => void {
    let set = this.listeners.get(poolId);

    if (!set) {
      set = new Set();
      this.listeners.set(poolId, set);
    }

    set.add(callback);

    return () => {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(poolId);
    };
  }

  private notifyLocal(poolId: string): void {
    const set = this.listeners.get(poolId);

    if (set) {
      for (const cb of set) cb();
    }
  }

  /**
   * The count table and the triggers that keep it.
   *
   * Each statement on the jobs table adds its net change per (pool, kind, state)
   * to its backend's slot: an insert counts its rows, an update moves them from
   * their old state to their new one. A delete changes nothing, so purged jobs
   * stay counted; truncating a pool subtracts its jobs itself. The rows are
   * written in key order, so two statements never lock each other's in reverse.
   *
   * A count table created beside existing jobs starts from them. Creating the
   * triggers locks the jobs table against writes until the schema commits, so
   * no job is counted twice or missed.
   */
  private async createCounts(client: PoolClient): Promise<void> {
    const exists = await client.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [this.countTable]);

    await client.query(`DROP TABLE IF EXISTS ${this.tablePrefix}_tally`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.countTable} (
        pool_id VARCHAR(26) NOT NULL REFERENCES ${this.poolsTable}(id) ON DELETE CASCADE,
        kind    TEXT        NOT NULL,
        state   TEXT        NOT NULL,
        slot    SMALLINT    NOT NULL,
        n       BIGINT      NOT NULL,
        PRIMARY KEY (pool_id, kind, state, slot)
      )
    `);

    const add = (changes: string) => `
      INSERT INTO ${this.countTable} (pool_id, kind, state, slot, n)
      SELECT pool_id, kind, state, pg_backend_pid() % ${COUNT_SLOTS}, SUM(n) FROM (${changes}) d
       GROUP BY pool_id, kind, state HAVING SUM(n) <> 0
       ORDER BY pool_id, kind, state
      ON CONFLICT (pool_id, kind, state, slot) DO UPDATE SET n = ${this.countTable}.n + EXCLUDED.n
    `;

    await client.query(`
      CREATE OR REPLACE FUNCTION ${this.jobsTable}_count_insert() RETURNS trigger AS $$
      BEGIN
        ${add('SELECT pool_id, kind, state, 1 AS n FROM new_rows')};
        RETURN NULL;
      END; $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION ${this.jobsTable}_count_update() RETURNS trigger AS $$
      BEGIN
        ${add('SELECT pool_id, kind, state, 1 AS n FROM new_rows UNION ALL SELECT pool_id, kind, state, -1 FROM old_rows')};
        RETURN NULL;
      END; $$ LANGUAGE plpgsql
    `);

    // Transition tables allow one event per trigger.
    await client.query(`DROP TRIGGER IF EXISTS ${this.jobsTable}_count_insert ON ${this.jobsTable}`);
    await client.query(`
      CREATE TRIGGER ${this.jobsTable}_count_insert AFTER INSERT ON ${this.jobsTable}
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION ${this.jobsTable}_count_insert()
    `);
    await client.query(`DROP TRIGGER IF EXISTS ${this.jobsTable}_count_update ON ${this.jobsTable}`);
    await client.query(`
      CREATE TRIGGER ${this.jobsTable}_count_update AFTER UPDATE ON ${this.jobsTable}
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION ${this.jobsTable}_count_update()
    `);

    if (exists.rows[0].t === null) {
      await client.query(`
        INSERT INTO ${this.countTable} (pool_id, kind, state, slot, n)
        SELECT pool_id, kind, state, 0, COUNT(*) FROM ${this.jobsTable} GROUP BY pool_id, kind, state
      `);
    }
  }

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.poolsTable} (
          id                VARCHAR(26) PRIMARY KEY,
          aging_seconds     INTEGER     NOT NULL DEFAULT 0,
          aging_boost       INTEGER     NOT NULL DEFAULT 1,
          aging_max         INTEGER     NOT NULL DEFAULT 0,
          lease_ms          BIGINT      NOT NULL DEFAULT 60000,
          max_attempts      INTEGER     NOT NULL DEFAULT 3,
          backoff_ms        BIGINT      NOT NULL DEFAULT 5000,
          backoff_max_ms    BIGINT      NOT NULL DEFAULT 300000,
          sweep_interval_ms BIGINT      NOT NULL DEFAULT 30000,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.jobsTable} (
          id           BIGSERIAL   PRIMARY KEY,
          pool_id      VARCHAR(26) NOT NULL REFERENCES ${this.poolsTable}(id) ON DELETE CASCADE,
          kind         TEXT        NOT NULL,
          state        TEXT        NOT NULL DEFAULT 'ready',
          priority     INTEGER     NOT NULL DEFAULT 0,
          eff_priority INTEGER     NOT NULL DEFAULT 0,
          requires     JSONB       NOT NULL DEFAULT '{}'::jsonb,
          params       JSONB       NOT NULL DEFAULT 'null'::jsonb,
          dedup_key    TEXT,
          exclusive    TEXT,
          attempts     INTEGER     NOT NULL DEFAULT 0,
          max_attempts INTEGER     NOT NULL DEFAULT 3,
          available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          lease_owner  TEXT,
          lease_until  TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          claimed_at   TIMESTAMPTZ,
          finished_at  TIMESTAMPTZ,
          result       JSONB,
          error        TEXT,
          CONSTRAINT ${this.jobsTable}_state_chk
            CHECK (state IN ('ready','claimed','done','failed','cancelled'))
        )
      `);

      // The claim's hot path: one pool's ready jobs in scheduling order, so the
      // scan stops at the first row the offer satisfies.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_ready_idx
          ON ${this.jobsTable} (pool_id, eff_priority DESC, created_at ASC, id ASC)
          WHERE state = 'ready'
      `);

      // Same, narrowed by kind. This is what stops a CPU worker from walking a
      // GPU-heavy backlog on every claim — pass `kinds` from workers.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_ready_kind_idx
          ON ${this.jobsTable} (pool_id, kind, eff_priority DESC, created_at ASC, id ASC)
          WHERE state = 'ready'
      `);

      // The exclusivity guarantee. The claim's NOT EXISTS is only the fast path:
      // under READ COMMITTED two claimers can both pass it.
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${this.jobsTable}_exclusive_idx
          ON ${this.jobsTable} (pool_id, exclusive)
          WHERE state = 'claimed' AND exclusive IS NOT NULL
      `);

      // At most one live job per dedup key; also the ON CONFLICT arbiter in add.
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${this.jobsTable}_dedup_idx
          ON ${this.jobsTable} (pool_id, dedup_key)
          WHERE dedup_key IS NOT NULL AND state IN ('ready','claimed')
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_lease_idx
          ON ${this.jobsTable} (lease_until) WHERE state = 'claimed'
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_aging_idx
          ON ${this.jobsTable} (pool_id, created_at) WHERE state = 'ready'
      `);

      // The oldest ready job of each kind, for `tally`.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_ready_kind_age_idx
          ON ${this.jobsTable} (pool_id, kind, created_at) WHERE state = 'ready'
      `);

      // Listing and purging a pool's jobs by state, and by kind within it.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.jobsTable}_pool_state_kind_idx
          ON ${this.jobsTable} (pool_id, state, kind)
      `);

      await this.createCounts(client);

      // Notify only on a real transition. A predicate as loose as
      // `NEW.state = 'ready'` would emit a notification per aged row, thousands
      // per sweep. A claim (ready -> claimed) correctly fires nothing.
      await client.query(`
        CREATE OR REPLACE FUNCTION ${this.jobsTable}_notify_trigger() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW.state = 'ready' THEN
              PERFORM pg_notify('${this.jobsChannel}', NEW.pool_id);
            END IF;
          ELSIF OLD.state IS DISTINCT FROM NEW.state
                AND (NEW.state = 'ready' OR OLD.state = 'claimed') THEN
            PERFORM pg_notify('${this.jobsChannel}', NEW.pool_id);
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql
      `);

      await client.query(`DROP TRIGGER IF EXISTS ${this.jobsTable}_notify ON ${this.jobsTable}`);
      await client.query(`
        CREATE TRIGGER ${this.jobsTable}_notify AFTER INSERT OR UPDATE ON ${this.jobsTable}
          FOR EACH ROW EXECUTE FUNCTION ${this.jobsTable}_notify_trigger()
      `);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

function toJob(row: JobRow): PoolJob {
  return {
    // BIGSERIAL arrives as a string; ids are compared and sorted by callers.
    id: Number(row.id),
    poolId: row.pool_id,
    kind: row.kind,
    state: row.state,
    priority: Number(row.priority),
    effPriority: Number(row.eff_priority),
    requires: row.requires ?? {},
    params: row.params,
    dedupKey: row.dedup_key ?? undefined,
    exclusive: row.exclusive ?? undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/** Escape LIKE wildcards so a dedup-key prefix is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Predicate and bound value for a job selector, as `$2` of the caller's query. */
function selectorSql(sel: PoolJobSelector): [string, string | number] {
  if ('jobId' in sel) return ['id = $2', sel.jobId];
  if ('dedupKey' in sel) return ['dedup_key = $2', sel.dedupKey];
  if ('kind' in sel) return ['kind = $2', sel.kind];
  return ['dedup_key LIKE $2', `${escapeLike(sel.dedupKeyPrefix)}%`];
}
