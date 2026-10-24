# Pool Registry

A work pool: one shared table of jobs claimed by **capability** rather than by queue name. Backed by PostgreSQL, with an in-memory implementation for the fast test tier.

## Why not a queue

A queue answers "what is next?". A pool answers "what is the best thing _I_ can run right now?". With queues, priority has to be encoded as queue identity plus worker argument order (`--queue high --queue low`), which means P priorities × R resources queue nodes, a service restart to retune, no anti-starvation, and no way for one job of a pipeline to outrank another.

In a pool the scheduling inputs live on the job, so one node covers every workload:

```
/var/pools/default
  job A  kind=gpu-faces     priority=100  requires={vramMb:3000}
  job B  kind=gpu-describe  priority=50   requires={vramMb:4000}
  job C  kind=cpu-convert   priority=10   requires={cpu:2}
       |
       +-- claim(offer={vramMb:16000}) -> A, then B
       +-- claim(offer={cpu:4})        -> C   (A and B do not match)
```

## Core Concepts

- **Capability matching**: a job declares `requires` (a numeric vector), a worker offers its remaining capacity. A job is eligible when `requires[k] <= offer[k]` for every `k`; a key missing from the offer counts as zero, so a CPU-only worker never sees GPU work.
- **Worker-side capacity**: the pool stores nothing about workers. The offer is the entire worker-side input to a claim — no registration, no heartbeat for liveness, no stale-worker reconciliation. A worker subtracts what it claimed and offers the remainder next time.
- **Leases**: a claim takes `leaseUntil`. The worker renews it while it works; the sweep reclaims it if the worker dies, whenever that happens.
- **Bounded aging**: `effPriority` starts at `priority` and the sweep promotes it one bucket at a time up to `agingMax`. Keeping `agingMax` **below the gap between priority lanes** means aging reorders _within_ a lane but can never promote across one — anti-starvation without losing strict lane ordering.
- **Exclusivity**: `exclusive` is a mutex class. At most one claimed job per `(pool, exclusive)`, enforced by a unique partial index rather than a read-then-write check.
- **Idempotent enqueue**: `dedupKey` is unique among non-terminal jobs. Re-adding upserts, so a retry, a re-advance or a restart all land on the same job instead of appending a duplicate nobody reaps.
- **Non-destructive reads**: `cat /var/pools/x` shows a snapshot. Claiming is explicit and takes a lease — unlike a queue, looking is not consuming.

## States

```
           add
            |
            v
+------> ready <------+ fail (attempts left, backed off)
|          |          | sweep (lease expired, attempts left)
|          |          | release (handed back unrun, attempt given back)
|        claim        |
|          v          |
|       claimed ------+
|          |
|          +--> done       complete()
|          +--> failed     fail() at maxAttempts, or sweep with none left
+----------+--> cancelled  cancel()
```

`availableAt` gates `ready`, which covers both an initial delay and retry backoff — there is no separate `scheduled` state.

`attempts` counts **starts**: `claim` increments it. The `attempts >= maxAttempts -> failed` decision lives only in `fail()` and the sweep, never in the claim. A worker that is SIGKILLed therefore burns an attempt, which is how a poison job stops crash-looping. A worker that stops on purpose calls `release()` instead, which makes the job claimable at once and gives the attempt back, so a planned restart costs a job nothing.

## Policy

Policy lives in the pool row, written by `touch()` from the node attrs — so retuning is an attrs edit, with no service restart:

| Attr                         | Default           | Meaning                                      |
| ---------------------------- | ----------------- | -------------------------------------------- |
| `agingSeconds`               | `0` (off)         | Queue age per aging step                     |
| `agingBoost`                 | `1`               | Effective-priority points per step           |
| `agingMax`                   | `0`               | Total aging cap; keep below the lane gap     |
| `leaseMs`                    | `60000`           | Default lease duration                       |
| `maxAttempts`                | `3`               | Default for jobs that do not set one         |
| `backoffMs` / `backoffMaxMs` | `5000` / `300000` | Retry backoff, `min(max, base * 2^attempts)` |
| `sweepIntervalMs`            | `30000`           | Maintenance cadence per registry instance    |

Promotions per job are `agingMax / agingBoost`; keep that small, since each promotion is an indexed row update across the whole ready backlog.

## Usage

```typescript
const registry = new MemoryPoolRegistry();
await registry.init();

await registry.touch('pool-id', { agingSeconds: 1800, agingBoost: 10, agingMax: 40 });

await registry.add('pool-id', {
  kind: 'gpu-faces',
  priority: 100,
  requires: { vramMb: 3000 },
  exclusive: 'person-mint',
  dedupKey: '/var/pipelines/instances/media-index/01J.../steps/detect-faces',
  params: { command: 'detect-faces /albums/x.jpg' },
});

// Blocking claim: resolves null only on a genuine abort.
const job = await registry.claim('pool-id', {
  owner: `${hostname}:${pid}:0`,
  offer: { vramMb: 16000 },
  kinds: ['gpu-faces', 'gpu-describe'],
}, signal);

if (job) {
  await registry.heartbeat('pool-id', job.id, owner); // renew while working
  await registry.complete('pool-id', job.id, owner, { ok: true });
  // ...or registry.fail(...) to retry with backoff, or registry.release(...) to hand it back unrun
}
```

## Sweep

`sweep()` is idempotent and does three things: fail jobs whose lease expired with no attempts left, return jobs whose lease expired to `ready` with backoff, and promote aging by one bucket. It runs from the blocking-claim tick and opportunistically before a non-blocking claim, throttled to `sweepIntervalMs` — there is no separate reaper process. It is never run from `stat()`: a read that mutates is a trap.

## Purge and counts

A terminal job stays as a row until `purge()` deletes it; the `pipeline-pruner` service purges every pool hourly, keeping a day. The PostgreSQL purge deletes in batches of 5000 by ascending id, each batch its own transaction, so a backlog of a million rows is many short deletes rather than one that holds its locks for minutes.

Each batch also adds what it deleted, per kind and state, to the `_pools_tally` table in the same statement, and `stat()` reads live rows and tally together in one statement. So `counts.done` and `counts.failed` include purged jobs and do not fall when a purge runs, which is what lets the metrics sampler difference them into throughput. `retry()` is the one thing that lowers them, by sending finished jobs back to `ready`. The live count is served by the `(pool_id, state, kind)` index alone.

## Notes

- The periodic poll behind a blocking claim is **load-bearing, not a safety net**. A notification does not mean this worker can claim (the offer may not match), and a job can become claimable with no row change at all — `availableAt` passing, or a lease lapsing. The poll interval is the upper bound on scheduling latency for those two cases.
- An expired-but-unswept lease still holds its exclusivity class. That is fail-safe, and consistent with the unique index, which cannot reference `now()`.
- The `requires`/`offer` match is not index-backed — only the ordering and the `kind` filter are. A scalar `kind =` can use the kind-scoped index and stop immediately; `= ANY` cannot provide the sort order, so it falls back to the pool-wide ordered index and filters. That is still correct and still globally ordered, it just walks the non-matching head, which is negligible beside any real step. It only becomes interesting for a high-throughput worker whose accepted kinds are a small minority at the head of a large backlog; the remedy there is to give that workload its own kind and worker.
