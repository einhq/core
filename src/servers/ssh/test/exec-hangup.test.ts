/**
 * A command run over SSH ends when its client goes away, even one blocked writing output the
 * client no longer reads: `ssh host 'cat stream.ts' | head -c 100` must not leave the `cat` behind.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { isStreamWriter } from '../../../registries/stream/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

/** The commands still running on an SSH exec's shell, after waiting up to `ms` for them to go. */
async function runningAfter(ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (true) {
    const running = harness.instance!.cem.states()
      .filter((s) => s.state === 'running' && s.opts?.tty.origin === 'ssh-exec')
      .map((s) => `${s.name} ${s.id}`);
    if (running.length === 0 || Date.now() >= deadline) return running;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (const [how, drop] of [['ends its connection', 'end'], ['vanishes', 'destroy']] as const) {
  Deno.test({
    name: `ssh server: a command writing to a client that ${how} is hung up`,
    sanitizeResources: false,
    sanitizeOps: false,
  }, async () => {
    await harness.start();
    const { vfs, shell } = harness.instance!;
    // A camera's stream: a chunk every few milliseconds, faster than a client that stopped reading takes it.
    await shell.run(`mknode -t stream /tmp/s-${drop}.ts`);
    const writer = await vfs.open(ADMIN_ACCESS, `/tmp/s-${drop}.ts`, { mode: 'w' });
    assert(isStreamWriter(writer));
    const chunk = new Uint8Array(64 * 1024);
    const feed = setInterval(() => void writer.write(chunk).catch(() => {}), 2);
    try {
      const client = await harness.connectSSH();
      const channel = await client.exec(`cat /tmp/s-${drop}.ts`);
      // Read a little, as `head -c` does, then let go of the client without reading the rest.
      const reader = channel.readable.getReader();
      assert(((await reader.read()).value?.length ?? 0) > 0);
      // Long enough for the client's window and the server's buffers to fill.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assertEquals((await runningAfter(0)).length, 1);
      if (drop === 'end') client.end();
      else client.destroy();

      assertEquals(await runningAfter(5000), []);
    } finally {
      clearInterval(feed);
      await writer.close();
      await harness.stop();
    }
  });
}

Deno.test({
  name: 'ssh server: a loop run over SSH ends with its client, not just the command running in it',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  try {
    const client = await harness.connectSSH();
    const channel = await client.exec('echo started; while true; do sleep 0.05; done');
    const reader = channel.readable.getReader();
    assert(((await reader.read()).value?.length ?? 0) > 0);
    client.end();

    assertEquals(await runningAfter(5000), []);
    // Long enough for a loop that survived to have started its next sleep
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEquals(await runningAfter(0), []);
  } finally {
    await harness.stop();
  }
});

Deno.test({
  name: "ssh server: a script's EXIT trap runs when it ends",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  try {
    const result = await harness.runSSH('trap "echo bye" EXIT; echo hi');
    assertEquals(result.stdout, 'hi\nbye\n');
  } finally {
    await harness.stop();
  }
});

/** Whether `name` runs here: the OpenSSH test needs OpenSSH's ssh and sshpass on the machine. */
const runs = (name: string): boolean => {
  try {
    return new Deno.Command('which', { args: [name], stdout: 'null', stderr: 'null' }).outputSync().success;
  } catch {
    return false;
  }
};

Deno.test({
  name: "OpenSSH's ssh ends when what reads its output stops, and so does the command",
  ignore: !runs('ssh') || !runs('sshpass'),
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  const { vfs, shell } = harness.instance!;
  await shell.run('mknode -t stream /tmp/s-openssh.ts');
  const writer = await vfs.open(ADMIN_ACCESS, '/tmp/s-openssh.ts', { mode: 'w' });
  assert(isStreamWriter(writer));
  const chunk = new Uint8Array(64 * 1024);
  const feed = setInterval(() => void writer.write(chunk).catch(() => {}), 2);
  try {
    // `ssh … 'cat stream.ts' | head -c …`: ssh's output closes after the first bytes; it keeps the
    // channel open until EiN ends the command, which a write to that output does.
    const ssh = new Deno.Command('sshpass', {
      args: [
        '-p',
        'admin',
        'ssh',
        '-p',
        String(harness.instance!.sshPort),
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'LogLevel=ERROR',
        'admin@localhost',
        'cat /tmp/s-openssh.ts',
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    const timer = setTimeout(() => ssh.kill(), 10_000);
    const reader = ssh.stdout.getReader();
    assert(((await reader.read()).value?.length ?? 0) > 0);
    await reader.cancel();

    const { code } = await ssh.status;
    clearTimeout(timer);
    assertEquals(code, 141);
    assertEquals(await runningAfter(5000), []);
  } finally {
    clearInterval(feed);
    await writer.close();
    await harness.stop();
  }
});
