/**
 * Job control + signals: background (`&`), the `jobs`, `kill` and `fg`
 * builtins over this shell's jobs, SIGHUP on shell close, and `detach` making a
 * job survive its shell.
 *
 * The API shell keeps one persistent Shell per WS connection and closes it on
 * disconnect, so `client.close()` exercises the real shell-close hang-up path.
 */

import { assert, assertEquals } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';
import type { NodeVFS } from '../../../../vfs/mod.ts';

const testCtx = createTestContext({ boot: true });

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/** The pid of a background job: every one runs as a command of its own, named `bg`. */
const bgPidOf = (output: string): string => {
  const m = output.match(/bg-[0-9A-Z]+/);
  if (!m) throw new Error(`no background job pid in output: ${JSON.stringify(output)}`);
  return m[0];
};

const readFile = async (vfs: NodeVFS, path: string): Promise<string> => {
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
  try {
    return await toText(handle.readable);
  } finally {
    await handle.close();
  }
};

const exited = (cem: { states(): { id: string; state: string; exitSignal?: string; exitCode?: number }[] }, pid: string) =>
  cem.states().find((s) => s.id === pid && s.state === 'exited');

Deno.test({
  name: 'job-control',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();

  try {
    await t.step('`&` is non-blocking and the job shows up in `jobs`', async () => {
      const client = await testCtx.server.createShellClient();
      const started = Date.now();
      const out = await client.execString('sleep 30 & jobs');
      // Returned promptly rather than blocking on the 30s sleep.
      assert(Date.now() - started < 5000, 'background command should not block');
      assert(/^\[1\]\+ {2}Running +sleep 30 &$/m.test(out), `jobs should list a running job: ${out}`);
      client.close();
    });

    await t.step('`kill <pid>` terminates a background job with SIGTERM', async () => {
      const client = await testCtx.server.createShellClient();
      const pid = bgPidOf(await client.execString('sleep 30 & jobs -l'));

      await client.exec(`kill ${pid}`);

      const ok = await waitFor(() => exited(ctx.cem, pid)?.exitSignal === 'SIGTERM');
      assert(ok, `expected ${pid} to exit with SIGTERM`);
      assertEquals(exited(ctx.cem, pid)?.exitCode, 143);
      client.close();
    });

    await t.step('`wait` gives a killed job the status bash would', async () => {
      const client = await testCtx.server.createShellClient();
      const out = await client.execString('sleep 30 & kill %1; wait %1; echo "st=$?"');
      assertEquals(out.trim(), 'st=143');
      client.close();
    });

    await t.step('`fg` blocks until the background job finishes', async () => {
      const client = await testCtx.server.createShellClient();
      const started = Date.now();
      const result = await client.exec('sleep 0.4 & fg');
      assertEquals(result.success, true);
      assert(Date.now() - started >= 300, 'fg should wait for the job to finish');
      client.close();
    });

    await t.step('closing the shell hangs up (SIGHUP) its running jobs', async () => {
      const client = await testCtx.server.createShellClient();
      const pid = bgPidOf(await client.execString('sleep 30 & jobs -l'));

      client.close();

      const ok = await waitFor(() => exited(ctx.cem, pid)?.exitSignal === 'SIGHUP');
      assert(ok, `expected ${pid} to be hung up (SIGHUP) on shell close`);
    });

    await t.step('a detached job survives shell close and logs to /var/logs/jobs', async () => {
      const client = await testCtx.server.createShellClient();
      const pid = bgPidOf(await client.execString('sleep 30 & jobs -l'));

      const detachRes = await client.exec(`detach ${pid}`);
      assert(detachRes.success, `detach should confirm: ${JSON.stringify(detachRes)}`);

      client.close();

      // It must NOT be hung up: no exit should appear shortly after close.
      const diedOnClose = await waitFor(() => !!exited(ctx.cem, pid), 700);
      assert(!diedOnClose, 'detached job should survive shell close');

      // Its output was redirected to a log file.
      const logExists = await ctx.vfs.exists(ADMIN_ACCESS, `/var/logs/jobs/${pid}/stdout.log`);
      assert(logExists, 'detached job should have a log file');

      // Clean up the survivor.
      await ctx.cem.signalPid(pid, 'SIGTERM');
    });

    // `&` backgrounds every kind of command — a list, a group, a loop, a
    // builtin — and registers it as a job, so a multi-step sweep can be
    // detached.
    await t.step('`&` backgrounds a compound command, not just a single one', async () => {
      const client = await testCtx.server.createShellClient();

      for (const form of ['sleep 30 && echo done', '{ sleep 30; }', '( sleep 30 )', 'for i in 1; do sleep 30; done']) {
        const started = Date.now();
        const out = await client.execString(`${form} & jobs -l`);
        assert(Date.now() - started < 5000, `${form} should not block`);
        const pid = bgPidOf(out);
        assert(out.includes(form), `jobs should show the command source: ${out}`);
        await ctx.cem.signalPid(pid, 'SIGTERM');
      }

      client.close();
    });

    await t.step('a builtin can be backgrounded too', async () => {
      const client = await testCtx.server.createShellClient();
      await client.exec('echo "sleep 30" > /home/admin/slow.sh');

      const out = await client.execString('source /home/admin/slow.sh & jobs -l');
      const pid = bgPidOf(out);
      assert(out.includes('source /home/admin/slow.sh'), `jobs should show the source line: ${out}`);

      await ctx.cem.signalPid(pid, 'SIGTERM');
      client.close();
    });

    // The whole point of the exercise: a sweep of several steps, detached, has
    // to keep running its *later* steps once its shell is gone, and its output
    // has to end up somewhere readable.
    await t.step('a detached compound job finishes its remaining steps after the shell closes', async () => {
      const client = await testCtx.server.createShellClient();
      const out = await client.execString('{ sleep 0.5; echo after-close; } & echo $!; disown');
      const pid = bgPidOf(out);

      client.close();

      const log = `/var/logs/jobs/${pid}/stdout.log`;
      const wrote = await waitFor(async () => (await readFile(ctx.vfs, log)).includes('after-close'), 5000);
      assert(wrote, `expected the step after the close in ${log}, got ${JSON.stringify(await readFile(ctx.vfs, log))}`);
    });

    await t.step('`detach --list` reports a detached job after its shell is gone', async () => {
      const client = await testCtx.server.createShellClient();
      const pid = bgPidOf(await client.execString('{ sleep 0.5; } & echo $!; disown'));

      const running = await client.execJson<{ pid: string; state: string; exitCode: number | null }[]>('detach --list');
      const before = running.find((entry) => entry.pid === pid);
      assertEquals(before?.state, 'running');

      client.close();

      // The shell it was started from is gone; a fresh one still finds it.
      const other = await testCtx.server.createShellClient();
      const done = await waitFor(async () => {
        const list = await other.execJson<{ pid: string; state: string }[]>('detach --list');
        return list.find((entry) => entry.pid === pid)?.state === 'exited';
      }, 5000);
      assert(done, 'a finished detached job should be reported as exited');

      const list = await other.execJson<{ pid: string; state: string; exitCode: number | null }[]>('detach --list');
      assertEquals(list.find((entry) => entry.pid === pid)?.exitCode, 0);
      other.close();
    });

    // `nohup` says whether it detached anything: a command that looks detached
    // and is not would die with the session.
    await t.step('`nohup` reports whether it actually detached anything', async () => {
      const client = await testCtx.server.createShellClient();

      const detached = await client.execJson<{ ok: boolean; pid: string; log: string }>('nohup sleep 30');
      assertEquals(detached.ok, true);
      assertEquals(detached.log, `/var/logs/jobs/${detached.pid}`);

      // Something that may well be over before the disown runs: either it
      // detached and named the log, or it failed and said why — never silence.
      const instant = await client.exec('nohup true');
      if (instant.success) {
        assert((instant.data as { log?: string }).log, `nohup reported nothing: ${JSON.stringify(instant)}`);
      } else {
        assert(String(instant.error).includes('nothing left to detach'), `nohup failed without saying why: ${JSON.stringify(instant)}`);
      }

      await ctx.cem.signalPid(detached.pid, 'SIGTERM');
      client.close();
    });

    // A detached sweep is a compound command that goes on running steps of its
    // own, and any step that shells out comes back through the owning shell's
    // runAndCapture. That shell is closed by then — closing it is what detaching
    // was for — and still runs the detached job's steps that shell out.
    await t.step('a detached job may still shell out after its shell is closed', async () => {
      const client = await testCtx.server.createShellClient();

      // Mirrors a detached sweep: the steps go in a script node and the
      // script is `nohup source`d, so the job is one compound command.
      await client.exec(
        "echo 'sleep 0.2' > /tmp/detach-probe.sh && " +
          "echo 'user-create detach-probe --title probe' >> /tmp/detach-probe.sh",
      );
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup source /tmp/detach-probe.sh');
      assertEquals(detached.ok, true);

      // The step that shells out has not run yet; take the shell away first.
      client.close();

      const other = await testCtx.server.createShellClient();
      const finished = await waitFor(async () => {
        const list = await other.execJson<{ pid: string; state: string }[]>('detach --list');
        return list.find((entry) => entry.pid === detached.pid)?.state === 'exited';
      }, 10000);
      assert(finished, 'the detached job should run to completion without its shell');

      const list = await other.execJson<{ pid: string; exitCode: number | null }[]>('detach --list');
      const stderr = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stderr.log`).catch(() => '(no stderr log)');
      assertEquals(
        list.find((entry) => entry.pid === detached.pid)?.exitCode,
        0,
        `a step that shells out must not fail with "shell is closed"; stderr: ${stderr}`,
      );

      // And it must have actually done the work, not just exited quietly.
      const exists = await other.exec('user-resolve detach-probe');
      assert(exists.success, 'the detached step that shelled out should have had its effect');
      other.close();
    });

    await t.step("a detached job keeps a builtin's output inside `$(…)` after its shell is closed", async () => {
      const client = await testCtx.server.createShellClient();

      // A substitution around a builtin, and ones around pipelines whose consumer
      // is a command, all after the owning shell has gone: every line reaches
      // stdout.log with its value.
      await client.exec('mkdir -p /tmp/subst-probe-dir && echo x > /tmp/subst-probe-dir/one');
      await client.exec(
        "echo 'export JSON_OUTPUT=0; sleep 0.2' > /tmp/subst-probe.sh && " +
          'echo \'X=$(echo hi); echo "got [$X]"\' >> /tmp/subst-probe.sh && ' +
          'echo \'W=$(printf "a\\nb\\nc\\n" | head -2); echo "head [$W]"\' >> /tmp/subst-probe.sh && ' +
          'echo \'Z=$(ls /tmp/subst-probe-dir | head -1 | head -1); echo "ls [$Z]"\' >> /tmp/subst-probe.sh',
      );
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup source /tmp/subst-probe.sh');
      assertEquals(detached.ok, true);
      client.close();

      const other = await testCtx.server.createShellClient();
      const finished = await waitFor(async () => {
        const list = await other.execJson<{ pid: string; state: string }[]>('detach --list');
        return list.find((entry) => entry.pid === detached.pid)?.state === 'exited';
      }, 10000);
      const stderr = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stderr.log`).catch(() => '(no stderr log)');
      assert(finished, `the detached job should not hang on a substitution; stderr: ${stderr}`);

      const stdout = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stdout.log`);
      assertEquals(stdout, 'got [hi]\nhead [a\nb]\nls [one]\n', `stderr: ${stderr}`);
      other.close();
    });

    await t.step('a detached job busy in `$(…)` survives the close of its shell', async () => {
      const client = await testCtx.server.createShellClient();

      // Enough files that `find`'s output outgrows the 64 KiB pipe: the
      // `FILES=($(find … -type f))` of a corpus sweep.
      await client.exec('mkdir -p /tmp/busy-probe-dir');
      for (let i = 0; i < 1200; i++) {
        await client.exec(`echo x > /tmp/busy-probe-dir/a-name-long-enough-to-fill-the-pipe-quickly-${i}`);
      }

      // The job spends nearly all its time inside a substitution, so the
      // shell's teardown — which comes a grace period after the close — lands
      // while one is open. That pipe is the job's, not the shell's.
      await client.exec(
        "echo 'export JSON_OUTPUT=0' > /tmp/busy-probe.sh && " +
          'echo \'for i in $(seq 1 30); do A=$(sleep 0.03; echo $i); B=$(find /tmp/busy-probe-dir -type f | head -2 | wc -l); echo "$i [$A] [$B]"; done\' >> /tmp/busy-probe.sh && ' +
          'echo \'F=($(find /tmp/busy-probe-dir -type f)); echo "n=${#F[@]}"\' >> /tmp/busy-probe.sh',
      );
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup source /tmp/busy-probe.sh');
      assertEquals(detached.ok, true);
      client.close();

      const other = await testCtx.server.createShellClient();
      const finished = await waitFor(async () => {
        const list = await other.execJson<{ pid: string; state: string }[]>('detach --list');
        return list.find((entry) => entry.pid === detached.pid)?.state === 'exited';
      }, 20000);
      const stderr = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stderr.log`).catch(() => '(no stderr log)');
      assert(finished, `the job should neither die nor hang; stderr: ${stderr}`);

      const stdout = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stdout.log`);
      const lines = stdout.trim().split('\n');
      assertEquals(lines.length, 31, `every iteration should have run; stdout: ${stdout} stderr: ${stderr}`);
      assertEquals(lines[29], '30 [30] [2]');
      assertEquals(lines[30], 'n=1200');
      other.close();
    });

    await t.step('a detached job writing through a redirect survives the close of its shell', async () => {
      const client = await testCtx.server.createShellClient();

      // The redirection's pipe is opened as soon as the job starts, before the
      // shell closes, and a builtin and a command go on writing to it after.
      await client.exec(
        "echo 'export JSON_OUTPUT=0' > /tmp/redirect-probe.sh && " +
          "echo 'for i in $(seq 1 20); do echo $i; seq $i $i; sleep 0.03; done > /tmp/redirect-probe.txt' >> /tmp/redirect-probe.sh && " +
          "echo 'echo done' >> /tmp/redirect-probe.sh",
      );
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup source /tmp/redirect-probe.sh');
      assertEquals(detached.ok, true);
      client.close();

      const other = await testCtx.server.createShellClient();
      const finished = await waitFor(async () => {
        const list = await other.execJson<{ pid: string; state: string }[]>('detach --list');
        return list.find((entry) => entry.pid === detached.pid)?.state === 'exited';
      }, 10000);
      const stderr = await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stderr.log`).catch(() => '(no stderr log)');
      assert(finished, `the job should finish; stderr: ${stderr}`);

      const list = await other.execJson<{ pid: string; exitCode: number | null }[]>('detach --list');
      assertEquals(list.find((entry) => entry.pid === detached.pid)?.exitCode, 0, `stderr: ${stderr}`);
      assertEquals((await readFile(ctx.vfs, '/tmp/redirect-probe.txt')).trim().split('\n').length, 40);
      assertEquals(await readFile(ctx.vfs, `/var/logs/jobs/${detached.pid}/stdout.log`), 'done\n');
      other.close();
    });

    await t.step('`kill -KILL` ends a detached job that TERM does not reach', async () => {
      const client = await testCtx.server.createShellClient();

      // `read` parks on the shell's stdin, which nothing ever writes: an await
      // no cooperative signal reaches, like a pipe whose writer is gone.
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup read STUCK');
      assertEquals(detached.ok, true);

      const stateOf = async () => {
        const list = await client.execJson<{ pid: string; state: string; exitCode: number | null }[]>('detach --list');
        return list.find((entry) => entry.pid === detached.pid);
      };

      await client.exec(`kill ${detached.pid}`);
      const survived = !(await waitFor(async () => (await stateOf())?.state === 'exited', 500));
      assert(survived, 'the probe job should be one that SIGTERM does not end, or this step tests nothing');

      const bad = await client.exec(`kill -SIGKILL ${detached.pid}`);
      assert(bad.success, `kill should accept SIGKILL: ${bad.error}`);
      const gone = await waitFor(async () => (await stateOf())?.state === 'exited', 3000);
      assert(gone, 'SIGKILL should end the job');
      assertEquals((await stateOf())?.exitCode, 137);
      client.close();
    });
  } finally {
    await testCtx.teardown();
  }
});
