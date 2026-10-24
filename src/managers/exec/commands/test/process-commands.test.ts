/**
 * ps, who and top as a shell reads them: what runs and whose it is, who is signed in and what
 * they run, and the dashboard as text where there is no terminal. Anyone but admin sees only
 * their own.
 */

import { assert, assertEquals } from '@std/assert';
import type { ProcessEntry, SessionEntry } from '../../../../lib/api/system.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ ssh: true });

/** This host, as the server sees a client on it. */
const LOOPBACK = /^(127\.0\.0\.1|::1)$/;

Deno.test({
  name: 'ps, who and top',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  let anna: ShellClient | undefined;

  try {
    await t.step('ps lists the commands running now, itself among them', async () => {
      const processes = await admin.execJson<ProcessEntry[]>('ps');
      const self = processes.find((entry) => entry.name === 'ps');
      assertEquals(self?.user, 'admin');
      assertEquals(self?.origin, 'web');
      assertEquals(self?.foreground, true);
      assert(self?.pid.startsWith('ps-'), self?.pid);
    });

    await t.step('ps shows a job started with &, and kill takes the pids it shows', async () => {
      // The job is a process of its own, in the background, labelled with its source text, and
      // runs its command in its foreground.
      const rows = await admin.execJson<ProcessEntry[]>('sleep 30 &\nps');
      const job = rows.find((entry) => entry.name === 'bg');
      const sleep = rows.find((entry) => entry.name === 'sleep');
      assertEquals(job?.foreground, false);
      assertEquals(job?.args, []);
      assertEquals(job?.label, 'sleep 30');
      assertEquals(sleep?.args, ['30']);
      assertEquals(sleep?.tty, job?.tty);

      assertEquals((await admin.execString(`kill ${sleep!.pid}; echo $?`)).trim(), '0');
      await admin.execString(`wait ${job!.pid}; true`);
      const after = await admin.execJson<ProcessEntry[]>('ps');
      assertEquals(after.some((entry) => entry.pid === sleep!.pid || entry.pid === job!.pid), false);
    });

    await t.step("ps --user keeps one person's commands", async () => {
      assertEquals(await admin.execJson<ProcessEntry[]>('ps --user nobody'), []);
      assert((await admin.execJson<ProcessEntry[]>('ps -u admin')).some((entry) => entry.name === 'ps'));
    });

    await t.step('who lists each session, and what it runs now', async () => {
      const sessions = await admin.execJson<SessionEntry[]>('who');
      const self = sessions.find((session) => session.command === 'who');
      assertEquals(self?.user, 'admin');
      assertEquals(self?.origin, 'web');
      assert(LOOPBACK.test(self?.from ?? ''), self?.from);
      assert(self!.since <= self!.activeAt, 'activity comes after the session opened');
    });

    await t.step('who shows the address an SSH login connects from', async () => {
      const ssh = await testCtx.harness.connectSSH();
      try {
        const channel = await ssh.shell();
        // The shell writes its prompt once it is open.
        const output = channel.readable.getReader();
        await output.read();
        const login = (await admin.execJson<SessionEntry[]>('who')).find((session) => session.origin === 'ssh');
        assert(LOOPBACK.test(login?.from ?? ''), login?.from);
        output.releaseLock();
        channel.close();
      } finally {
        ssh.end();
      }
    });

    await t.step('ps and who give anyone but admin only their own', async () => {
      await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password secret');
      anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret' });

      const processes = await anna.execJson<ProcessEntry[]>('ps');
      assert(processes.some((entry) => entry.name === 'ps'));
      assertEquals(processes.filter((entry) => entry.user !== 'anna'), []);

      assertEquals((await anna.execJson<SessionEntry[]>('who')).map((session) => session.user), ['anna']);
      assert((await admin.execJson<SessionEntry[]>('who')).some((session) => session.user === 'anna'), 'admin sees everyone');
    });

    await t.step("kill reaches only the caller's own processes, and admin everyone's", async () => {
      const job = (await admin.execJson<ProcessEntry[]>('sleep 30 &\nps')).find((entry) => entry.name === 'bg')!;
      assertEquals((await anna!.exec(`kill ${job.pid}`)).success, false);
      assert((await admin.execJson<ProcessEntry[]>('ps')).some((entry) => entry.pid === job.pid), 'still running');

      const own = (await anna!.execJson<ProcessEntry[]>('sleep 30 &\nps')).find((entry) => entry.name === 'bg')!;
      assertEquals((await admin.execString(`kill ${own.pid} ${job.pid}; echo $?`)).trim(), '0');
      await admin.execString(`wait ${job.pid}; true`);
    });

    await t.step('the text tables have a header and a row per entry', async () => {
      const lines = async (command: string) => (await admin.execString(`export JSON_OUTPUT=0\n${command}`)).split('\n').map((line) => line.trimEnd());
      const ps = await lines('ps');
      assert(ps[0].startsWith('PID'), ps[0]);
      assert(ps.some((line) => /^ps-\S+\s+admin\s+web\/\S{4}\s+\d+s\s+ps$/.test(line)), ps.join('\n'));
      const withJob = await lines('sleep 30 &\nps\nkill $!');
      assert(withJob.some((line) => /^bg-\S+\s+admin\s+web\/\S{4}\s+\d+s\s+bg: sleep 30 &$/.test(line)), withJob.join('\n'));
      const withLoop = await lines('while true; do\n  sleep 30\ndone &\nps\nkill $!');
      assert(withLoop.some((line) => line.endsWith('bg: while true; do sleep 30; done &')), withLoop.join('\n'));
      const who = await lines('who');
      assert(who[0].startsWith('USER'), who[0]);
      assert(who.some((line) => /^admin\s+web\/\S{4}\s+(127\.0\.0\.1|::1)\s+\d\d:\d\d\s+\d+s\s+who$/.test(line)), who.join('\n'));
    });

    await t.step('top without a terminal writes one frame as plain text', async () => {
      const text = await admin.execString('top');
      assert(text.startsWith(' EiN top '), text);
      for (const title of ['CPU', 'Memory', 'Processes']) assert(text.includes(`─ ${title} `), text);
      assert(!text.includes('\x1b['), 'no escape sequences without a terminal');
      assert(text.includes(' top'), 'its own process is on the list');
    });

    await t.step('top -n writes that many frames', async () => {
      const text = await admin.execString('top -n 2 -d 0.5');
      assertEquals(text.split('\n').filter((line) => line.startsWith(' EiN top ')).length, 2);
    });

    await t.step('top refuses an interval or a frame count it cannot use', async () => {
      await cmd.shouldFailWith('top -d 0', '-d must be a number of seconds');
      await cmd.shouldFailWith('top -n 1.5', '-n must be a whole number');
    });
  } finally {
    anna?.close();
    admin.close();
    await testCtx.teardown();
  }
});
