/**
 * pool-contention-bench — interactive command latency while background work
 * saturates the postgres pool.
 *
 * The third of the shell-latency benchmarks, and it measures what the other two
 * cannot. `vfs-churn-bench.sh` reports postgres transactions per mutation and
 * `exec-cost-bench.ts` reports them per invocation — both count *work*, and
 * both run on an idle box where the pool is never the constraint. The symptom
 * this exists for is contention: in production under the media-index crawl a trivial
 * builtin cost ~39 ms and `ls /etc` ~430 ms against a main thread with 40% idle,
 * which is queueing delay and invisible to a transaction count.
 *
 * So this one makes the contention rather than waiting for it. It installs a
 * service — declared `workClass: background`, exactly as the pipeline engine and
 * the pool workers are — that runs VFS-dense loops for the duration, and times
 * an ordinary API-shell command against that. The service is the load-bearing
 * detail: background is a property of the *context* a command runs in, so load
 * driven from another API-shell session would be tagged interactive and would
 * measure nothing.
 *
 * Two runs make a result. Restart the instance between them:
 *
 *     POSTGRES_POOL_MAX=8 POSTGRES_POOL_RESERVED=0 deno task dev   # before
 *     POSTGRES_POOL_MAX=8 POSTGRES_POOL_RESERVED=3 deno task dev   # after
 *
 * A small `max` is the point on a developer box: with 20 connections and no
 * crawl there is nothing to contend for, and the run reports the same number
 * twice. Eight makes the pool the constraint the way the crawl makes it one in
 * production.
 *
 * Usage:
 *   deno run -A scripts/pool-contention-bench.ts [--workers 24] [--seconds 20]
 *                                                [--command 'ls /etc'] [--url http://localhost:8080]
 */

import { parseArgs } from '@std/cli/parse-args';
import { ShellClient } from '../src/testing/shell-client.ts';

const flags = parseArgs(Deno.args, {
  string: ['workers', 'seconds', 'command', 'url'],
  default: {
    // Comfortably more than the pool, so it is saturated rather than merely
    // busy — the crawl's 4 engine steps + 4 cpu + 2 gpu workers each run
    // several VFS calls deep, so the real in-flight count is well above ten.
    workers: '24',
    // A fixed window rather than a fixed sample count, so the background
    // throughput below is measured over the same duration in both runs. With a
    // count, the faster run finishes sooner and its throughput is read off a
    // shorter, noisier window — which is exactly the comparison being made.
    seconds: '20',
    // Touches the VFS for real (path resolve + children) without being a
    // whole-corpus query, which is what an interactive action mostly is.
    command: 'ls /etc',
    url: 'http://localhost:8080',
  },
});

const workers = Number(flags.workers);
const seconds = Number(flags.seconds);

const LOAD_DIR = '/tmp/pool-contention-bench';
const SERVICE = 'pool-contention-bench';

/** Cumulative committed transactions, straight from the postgres container. */
const xact = async (): Promise<number> => {
  const cmd = new Deno.Command('podman', {
    args: ['exec', '-i', 'postgres', 'psql', '-U', 'ein', '-d', 'ein', '-tAc', "select xact_commit from pg_stat_database where datname='ein'"],
    stdout: 'piped',
    stderr: 'null',
  });
  const { stdout } = await cmd.output();
  return Number(new TextDecoder().decode(stdout).trim());
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const client = await ShellClient.connect(flags.url);
const login = await client.exec('login admin admin');
if (!login.success) {
  console.error(`login failed: ${login.error}`);
  Deno.exit(1);
}

const run = async (command: string, timeout = 30_000): Promise<string> => {
  const result = await client.exec(command, { timeout });
  if (!result.success) throw new Error(`${command}: ${result.error}`);
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
};

/**
 * The load service.
 *
 * `&` per worker and the last loop in the foreground, because the shell has no
 * `wait` — the foreground loop is what keeps `start.sh` from returning and the
 * service from being reaped. Each iteration is a path resolve plus a children
 * read plus a file read, which is the shape of the work a pipeline step spends
 * its postgres time on.
 */
const LOOP = 'while true; do ls /etc > /dev/null; cat /etc/bashrc > /dev/null; done';
const startScript = [
  ...Array.from({ length: workers - 1 }, () => `( ${LOOP} ) &`),
  LOOP,
];

const teardown = async () => {
  try {
    await run(`service stop ${SERVICE}`);
  } catch { /* not running */ }
  try {
    await run(`service disable ${SERVICE}`);
  } catch { /* not enabled */ }
  try {
    await run(`service remove ${SERVICE}`);
  } catch { /* not added */ }
  try {
    await run(`rm -rf ${LOAD_DIR}`);
  } catch { /* already gone */ }
};

await teardown();

try {
  await run(`mkdir -p ${LOAD_DIR}`);
  await run(`echo '{"description":"pool contention bench load","workClass":"background"}' > ${LOAD_DIR}/config.json`);

  // Line by line: the shell has no heredoc, and a single `echo` of the whole
  // script would need the newlines to survive its own quoting.
  for (const [index, line] of startScript.entries()) {
    await run(`echo "${line}" ${index === 0 ? '>' : '>>'} ${LOAD_DIR}/start.sh`);
  }

  await run(`service add ${SERVICE} ${LOAD_DIR}`);
  await run(`service enable ${SERVICE}`);
  await run(`service start ${SERVICE}`);

  // Let the workers get in and the pool reach steady state before timing.
  await sleep(3000);

  // Warm-up: the first invocation of any command pays for staging and whatever
  // else is built lazily, which is a real cost but not a per-exec one.
  await run(flags.command, 120_000);

  const before = await xact();
  const started = performance.now();
  const deadline = started + seconds * 1000;
  const timings: number[] = [];

  while (performance.now() < deadline) {
    const t0 = performance.now();
    await run(flags.command, 120_000);
    timings.push(performance.now() - t0);
  }

  const window = performance.now() - started;
  const after = await xact();

  const sorted = [...timings].sort((a, b) => a - b);
  const total = timings.reduce((sum, value) => sum + value, 0);

  console.log(`command            ${JSON.stringify(flags.command)}`);
  console.log(`background workers ${workers}`);
  console.log(`window             ${seconds} s (${timings.length} samples)`);
  console.log('');
  console.log(`p50                ${percentile(sorted, 0.5).toFixed(0)} ms      <-- the number to move`);
  console.log(`p95                ${percentile(sorted, 0.95).toFixed(0)} ms`);
  console.log(`max                ${sorted[sorted.length - 1].toFixed(0)} ms`);
  console.log(`mean               ${(total / timings.length).toFixed(0)} ms`);
  console.log('');
  // The check that the reservation is not simply stalling the crawl to make the
  // shell look good. Almost all of these transactions are the load service's.
  console.log(`pg transactions    ${after - before} in ${(window / 1000).toFixed(1)} s  (${((after - before) / (window / 1000)).toFixed(0)}/s background throughput)`);

  // The series moved with the root-layout split — `/var/logs/metrics` now,
  // `/logs/metrics` before it — so ask rather than hardcode.
  console.log('');
  let sample = '';
  for (const path of ['/var/logs/metrics/runtime', '/logs/metrics/runtime']) {
    try {
      sample = (await run(`tail -n 1 ${path}`)).trim();
    } catch {
      continue; // No such log node here; try the other layout.
    }
    if (sample) {
      console.log(`runtime metrics    ${sample}`);
      break;
    }
  }
  // The sampler may not have written a row yet; the latency numbers stand on their own.
  if (!sample) console.log('runtime metrics    none yet — is metrics-sampler running?');
} finally {
  await teardown();
  client.close();
}
