/**
 * exec-cost-bench — postgres cost of a single command invocation.
 *
 * Companion to `vfs-churn-bench.sh`, and it exists because that script measures
 * the wrong half. A churn loop runs as ONE long shell script, so `Shell.run()`
 * is entered once for thousands of commands — and everything that happens per
 * *invocation* (the bash parse, `#!ts` staging, `persist()` writing the tty
 * node) is amortised to nothing. A `persist()` fix measured 19.2 before and 19.2
 * after on that benchmark while being untested by it.
 *
 * The API shell is the right driver: one `exec` message is one `runAndCapture`,
 * which is exactly what the UI does per action and the pipeline engine does per
 * step.
 *
 * Reports postgres transactions per exec. Wall time is printed but is not the
 * metric — locally the loop is idle and fast, and the symptom being chased is
 * contention on a loaded box.
 *
 * Usage:
 *   deno run -A scripts/exec-cost-bench.ts [--n 200] [--command 'true'] [--url http://localhost:8080]
 */

import { parseArgs } from '@std/cli/parse-args';
import { ShellClient } from '../src/testing/shell-client.ts';

const flags = parseArgs(Deno.args, {
  string: ['n', 'command', 'url'],
  default: {
    // 1000 because fixed background traffic swamps a smaller sample: at 200 the
    // same build reported 3.6, 5.6 and 5.7; at 1000 it reports 5.2, 5.4, 5.2.
    n: '1000',
    // `true` is the cheapest possible body: whatever this costs is pure
    // per-invocation overhead, with no VFS work of its own.
    command: 'true',
    url: 'http://localhost:8080',
  },
});

const count = Number(flags.n);

/** Cumulative committed transactions, straight from the postgres container. */
const xact = async (): Promise<number> => {
  const cmd = new Deno.Command('podman', {
    args: [
      'exec',
      '-i',
      'postgres',
      'psql',
      '-U',
      'ein',
      '-d',
      'ein',
      '-tAc',
      "select xact_commit from pg_stat_database where datname='ein'",
    ],
    stdout: 'piped',
    stderr: 'null',
  });
  const { stdout } = await cmd.output();
  return Number(new TextDecoder().decode(stdout).trim());
};

/**
 * Wait until postgres is quiet.
 *
 * Mutations are only half-synchronous — the exec returns when the write commits,
 * but the published event is handed to a macrotask and the relay and engine keep
 * working. Sampling without this gate measures an arbitrary slice of one run's
 * tail plus the previous run's.
 */
const quiesce = async (): Promise<void> => {
  let calm = 0;
  while (calm < 2) {
    const before = await xact();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after = await xact();
    calm = (after - before) / 2 < 40 ? calm + 1 : 0;
  }
};

const client = await ShellClient.connect(flags.url);
const login = await client.exec('login admin admin');
if (!login.success) {
  console.error(`login failed: ${login.error}`);
  Deno.exit(1);
}

// One warm-up: the first invocation of any command pays for staging and
// whatever else is lazily built, which is a real cost but not a per-exec one.
await client.exec(flags.command);

await quiesce();
const before = await xact();
const start = performance.now();

for (let i = 0; i < count; i++) {
  const result = await client.exec(flags.command);
  if (!result.success) {
    console.error(`exec failed at ${i}: ${result.error}`);
    client.close();
    Deno.exit(1);
  }
}

const wall = performance.now() - start;
await quiesce();
const after = await xact();

client.close();

const delta = after - before;
console.log(`command          ${JSON.stringify(flags.command)}`);
console.log(`execs            ${count}`);
console.log(`wall             ${(wall / 1000).toFixed(1)} s  (${(wall / count).toFixed(1)} ms each)`);
console.log(`pg transactions  ${delta}`);
console.log(`per exec         ${(delta / count).toFixed(1)}      <-- the number to move`);
