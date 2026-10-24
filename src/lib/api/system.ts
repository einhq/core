export type MetricPoint = { at: number; value: number };

/** `host-metrics`: this container's CPU and memory now, and the event loop's lag, each with its recent history. */
export type HostMetrics = {
  cpu?: { percent?: number; cores: number; load1?: number; series: MetricPoint[] };
  memory?: { usedBytes: number; limitBytes?: number; percent?: number; series: MetricPoint[] };
  /** How late a ready callback ran in the last sampling interval; the series is the p99. */
  lag?: { p99Ms: number; maxMs: number; series: MetricPoint[] };
  /** False until the sampler has written anything — the UI says "warming up". */
  sampled: boolean;
};

export type StorageTier = {
  tier: string;
  path: string;
  device: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent?: number;
  /** Negative means the tier is draining. Undefined when there is no trend yet. */
  bytesPerDay?: number;
  daysUntilFull?: number;
};

/** `df`: free space per storage tier and how fast it is going, and the database's size. */
export type DiskUsage = { tiers: StorageTier[]; databaseBytes?: number };

/** `system-info`: which instance this is, and what it runs. */
export type SystemInfo = {
  hostname: string;
  /** Core's own version. */
  version: string;
  /** The module API core provides, which every module's `coreApi` range is checked against. */
  api: string;
  /**
   * The commit the running tree is, and its date (ISO 8601), and each module checkout's commit by
   * name (`-dirty` when it had uncommitted changes). Absent when nothing says.
   */
  build?: { commit: string; date: string; modules?: Record<string, string> };
  /** PostgreSQL's server version. Absent without a database, or when it does not answer. */
  database?: string;
  denoVersion: string;
  uptimeMs: number;
};

/**
 * Where a shell's input comes from: an SSH login, a command run over SSH, the UI's terminal
 * panel, the web UI's own connection, a service, or the instance itself.
 */
export type ShellOrigin = 'ssh' | 'ssh-exec' | 'terminal' | 'web' | 'service' | 'system';

/** One row of `ps`: a command running now. */
export type ProcessEntry = {
  /** What `kill` takes. */
  pid: string;
  name: string;
  args: string[];
  /** What it runs, where name and arguments do not say: a background job's source text. */
  label?: string;
  uid: number;
  user: string;
  /** The shell it runs in (its `$TTY_NAME`). */
  tty: string;
  origin: ShellOrigin;
  /** The service whose shell it runs in. */
  service?: string;
  startedAt: number;
  /** False for a job started with `&`. */
  foreground: boolean;
  cwd: string;
};

/** One row of `who`: an open session — an SSH login, a terminal panel or a web UI connection. */
export type SessionEntry = {
  tty: string;
  origin: Extract<ShellOrigin, 'ssh' | 'terminal' | 'web'>;
  /** The client's address. */
  from?: string;
  uid: number;
  user: string;
  /** When the shell opened. */
  since: number;
  /** The last input or command. */
  activeAt: number;
  cwd: string;
  /** The command in the foreground now, with its arguments. */
  command?: string;
};

/** One row of `service-list`. */
export type ServiceEntry = {
  name: string;
  status: string;
  enabled: boolean;
  description: string;
  restartCount: number;
  /** When the running instance started, epoch ms. Absent when not running. */
  startedAt?: number;
  /**
   * One line the service says about itself, from its own `statusCommand` (`service-list --detail`).
   *
   * `running` is the only thing the manager can report, and for some services that is the
   * uninteresting half: the model server can be up and captioning on the CPU at a fifth of
   * its rate, which is invisible from here and looks exactly like a slow crawl. The service
   * declares the command; core never learns what it means.
   */
  detail?: string;
};

/** One check of `health`: a name, whether it is fine, and why. */
export type HealthCheck = {
  name: string;
  /** `fail` means a person has something to do; `warn` something worth knowing that sorts itself out. */
  state: 'ok' | 'warn' | 'fail';
  reason: string;
  /** The service that answered it (its `checkCommand`); absent for core's own. */
  service?: string;
};

/**
 * `health`: is the system fine and keeping up, in one word, and the checks that word comes from.
 *
 * - `healthy` — nothing is waiting that could run.
 * - `catching-up` — work is waiting, and some of it finished in the last hour.
 * - `stuck` — work is waiting, and none of it finished in the last hour.
 * - `needs-person` — a check failed: something will not sort itself out.
 */
export type HealthAnswer = {
  verdict: 'healthy' | 'catching-up' | 'stuck' | 'needs-person';
  /** The verdict in a sentence, with the number that decided it. */
  summary: string;
  checks: HealthCheck[];
};

/** A meter a service draws beside the host's (its `gaugeCommand`): ems's card memory, say. */
export type Gauge = {
  label: string;
  /** 0–100, for the bar; absent for a gauge that is only a value. */
  percent?: number;
  value: string;
  /** The service that answered it. */
  service?: string;
};

/** One entry of `dmesg`. */
export type LogLine = { timestamp: string; level: string; name: string; message: string; extra: string };

/** One job kind of a pool: its counts now and how fast it moves. */
export type PoolKindThroughput = {
  kind: string;
  ready: number;
  claimed: number;
  done: number;
  failed: number;
  perHour?: number;
  inPerHour?: number;
  etaMs?: number;
  /**
   * Set when this kind has ready jobs and no live worker offers it, and has for longer than
   * the grace period — the backlog will never drain, and `etaMs` is meaningless for it. Not
   * the same as a worker being on another kind right now, which is waiting that ends.
   */
  unservableSince?: number;
  /** When the oldest of its ready jobs was added: how long the back of its line has waited. */
  oldestReadyAt?: number;
  /**
   * Set while a worker rests the kind after a step of it could not run (exit 75): when it is tried
   * again. Nothing failed; the kind waits for EMS.
   */
  restingUntil?: number;
};

/** A pool's counts now and how fast it moves, from the sampler's series. */
export type PoolThroughput = {
  name: string;
  /** The pool node, for a `pool` command the page names — the alert on an unservable kind. */
  path: string;
  /**
   * `intake` is the engine's own staging pool — matched triggers waiting to
   * become instances, claimed by the engine rather than by a worker. Listing
   * it beside the pools jobs actually run out of reads as a second work
   * queue, which it is not; it is one stage of getting work made.
   */
  role: 'intake' | 'work';
  ready: number;
  claimed: number;
  done: number;
  failed: number;
  /** Jobs finishing per hour — what leaves. */
  perHour?: number;
  /**
   * Jobs arriving per hour — what enters.
   *
   * Derived from `ready + claimed + done + failed`, which is every job ever added and so a
   * counter in its own right; `rate` reads a fall in it as a reset, which is what a
   * cancellation or a purge looks like. Worth having next to the outflow: a backlog with a
   * finishing rate but no arrival rate is draining, and the same backlog with both is only
   * keeping up — the two look identical from the depth alone.
   */
  inPerHour?: number;
  /** Longest per-kind estimate — kinds drain in parallel, not in sequence. */
  etaMs?: number;
  /** Per job kind, since one pool mixes work of very different cost. */
  kinds?: PoolKindThroughput[];
};

/**
 * `pool-stat`: one pool's live counts and policy, with its throughput and the workers on it.
 * Without a path, every pool's, as an array.
 */
export type PoolStatAnswer = PoolThroughput & {
  workers: PoolWorkerInfo[];
  /** Claimable backlog (`ready` jobs). */
  backlog: number;
  counts: Record<'ready' | 'claimed' | 'done' | 'failed' | 'cancelled' | 'total', number>;
  policy: {
    agingSeconds: number;
    agingBoost: number;
    agingMax: number;
    leaseMs: number;
    maxAttempts: number;
    backoffMs: number;
    backoffMaxMs: number;
    sweepIntervalMs: number;
  };
};

/** `pool-wake`: the kinds whose rests it ended, and the pool each was resting on. */
export type PoolWakeAnswer = { ok: true; woken: { pool: string; kind: string }[] };

/**
 * A live pool worker and the kind it is on right now (`pool-stat`, per pool).
 *
 * The pool stores nothing about workers, so this is the only place the answer exists. Two
 * questions need it: why a kind with ready jobs is not draining (its worker is on another
 * one), and whether a kind has any worker at all. The second is answered as
 * `kinds[].unservableSince`, joined by the tracker `metrics-sampler` feeds.
 */
export type PoolWorkerInfo = {
  kinds: string[];
  currentKind?: string;
  kindSince?: number;
  kindQuantumMs: number;
  reserveKinds: string[];
  reserveCapacity: Record<string, number>;
  nextReserveKind?: string;
  /** Reserved kind the worker is holding free capacity for; a full-looking pool admitting nothing has this set. */
  accumulatingFor?: string;
  /** Kinds resting after a step could not run: until when. */
  resting: Record<string, { until: number }>;
};

export type NodeTypeGrowth = {
  type: string;
  total: number;
  totalBytes: number;
  years: { year: string; count: number; total: number; bytes: number; totalBytes: number }[];
  months: { month: string; count: number; total: number; bytes: number; totalBytes: number }[];
};

export type StatsOverview = {
  nodeTypes: NodeTypeGrowth[];
};
