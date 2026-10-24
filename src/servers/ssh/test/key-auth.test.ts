/**
 * Signing in to EiN's SSH server with a key from `~/.ssh/authorized_keys`, and
 * disabled accounts refused whatever the credential.
 *
 * The last steps drive OpenSSH's own `ssh` and `ssh-copy-id -s` (the recipe the
 * user docs give) and are skipped where those tools are not installed.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { Client, generateKeyPair } from 'ssh2';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

async function have(tool: string): Promise<boolean> {
  try {
    return (await new Deno.Command('which', { args: [tool], stdout: 'null', stderr: 'null' }).output()).success;
  } catch {
    return false;
  }
}

/** Log in with a private key and run one command; rejects when auth fails */
async function runWithKey(port: number, username: string, privateKey: string, command: string): Promise<string> {
  const client = new Client();
  await client.connect({ host: '127.0.0.1', port, username, privateKey, hostVerifier: () => true, readyTimeout: 10000 });
  try {
    const channel = await client.exec(command);
    let out = '';
    const decoder = new TextDecoder();
    for await (const chunk of channel.readable) out += decoder.decode(chunk, { stream: true });
    return out;
  } finally {
    client.end();
  }
}

function text(result: { data: unknown; error?: string }): string {
  return `${typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')}${result.error ?? ''}`;
}

Deno.test({
  name: 'ssh server: public key login',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  const port = primary.sshPort;
  const tmp = await Deno.makeTempDir({ prefix: 'ein-key-auth-' });
  let admin: ShellClient | undefined;
  let anna: ShellClient | undefined;

  const ed = await generateKeyPair('ed25519', { comment: 'anna@laptop' });
  const rsa = await generateKeyPair('rsa', { bits: 2048, comment: 'anna@desktop' });
  const stranger = await generateKeyPair('ed25519');

  try {
    admin = await harness.createShellClient();
    await admin.exec('user-create anna && user-passwd anna --new-password secret');
    anna = await harness.createShellClient({ username: 'anna', password: 'secret' });

    const writeKeys = async (lines: string[], mode = '600') => {
      await anna!.exec('mkdir -p /home/anna/.ssh && chmod 700 /home/anna/.ssh');
      await anna!.exec(`echo "${lines[0]}" > /home/anna/.ssh/authorized_keys`);
      for (const line of lines.slice(1)) await anna!.exec(`echo "${line}" >> /home/anna/.ssh/authorized_keys`);
      await anna!.exec(`chmod ${mode} /home/anna/.ssh/authorized_keys`);
    };

    await t.step('a listed key signs in, ed25519 and RSA alike', async () => {
      await writeKeys([ed.public, rsa.public]);
      assertStringIncludes(await runWithKey(port, 'anna', ed.private, 'user-whoami'), 'anna');
      assertStringIncludes(await runWithKey(port, 'anna', rsa.private, 'user-whoami'), 'anna');
    });

    await t.step('a key not listed does not', async () => {
      await assertRejects(() => runWithKey(port, 'anna', stranger.private, 'user-whoami'));
      // Nor does anna's key sign in as someone else
      await assertRejects(() => runWithKey(port, 'admin', ed.private, 'user-whoami'));
    });

    await t.step('keys others could have written are not honoured', async () => {
      await writeKeys([ed.public], '660');
      await assertRejects(() => runWithKey(port, 'anna', ed.private, 'user-whoami'));

      await writeKeys([ed.public], '600');
      await anna!.exec('chmod 770 /home/anna/.ssh');
      await assertRejects(() => runWithKey(port, 'anna', ed.private, 'user-whoami'));

      await anna!.exec('chmod 700 /home/anna/.ssh');
      assertStringIncludes(await runWithKey(port, 'anna', ed.private, 'user-whoami'), 'anna');
    });

    await t.step('a line with options is skipped rather than half-honoured', async () => {
      await writeKeys([`command=\\"date\\" ${ed.public}`]);
      await assertRejects(() => runWithKey(port, 'anna', ed.private, 'user-whoami'));
      await writeKeys([ed.public]);
    });

    await t.step('a disabled account signs in by nothing', async () => {
      await admin!.exec('user-disable anna');

      await assertRejects(() => runWithKey(port, 'anna', ed.private, 'user-whoami'));
      await assertRejects(async () => {
        const client = new Client();
        try {
          await client.connect({ host: '127.0.0.1', port, username: 'anna', password: 'secret', hostVerifier: () => true });
        } finally {
          client.end();
        }
      });
      const login = await admin!.exec('login anna secret 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(login), 'account disabled');

      await admin!.exec('user-enable anna');
      assertStringIncludes(await runWithKey(port, 'anna', ed.private, 'user-whoami'), 'anna');
      // Disabling signed anna's open shell out; the steps below write as her.
      await anna!.exec('login anna secret');
    });

    await t.step({
      name: "OpenSSH's ssh signs in with the key",
      ignore: !await have('ssh'),
      fn: async () => {
        // RSA: OpenSSH signs it with rsa-sha2-* only when the server lists that in server-sig-algs
        await writeKeys([rsa.public]);
        const keyFile = join(tmp, 'id_rsa');
        await Deno.writeTextFile(keyFile, rsa.private, { mode: 0o600 });
        const out = await new Deno.Command('ssh', {
          args: [
            '-i',
            keyFile,
            '-p',
            String(port),
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'IdentitiesOnly=yes',
            '-o',
            'LogLevel=ERROR',
            'anna@127.0.0.1',
            'user-whoami',
          ],
        }).output();
        assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
        assertStringIncludes(new TextDecoder().decode(out.stdout), 'anna');
      },
    });

    await t.step({
      name: 'ssh-copy-id -s installs a key that then signs in',
      ignore: !(await have('ssh-copy-id') && await have('sshpass')),
      fn: async () => {
        await admin!.exec('user-create bob && user-passwd bob --new-password hunter2');
        const bobKey = await generateKeyPair('ed25519', { comment: 'bob@laptop' });
        const keyFile = join(tmp, 'id_bob');
        await Deno.writeTextFile(keyFile, bobKey.private, { mode: 0o600 });
        await Deno.writeTextFile(`${keyFile}.pub`, `${bobKey.public}\n`);

        // ssh-copy-id stages its work under ~/.ssh: a home of the test's own, whatever the machine's.
        await Deno.mkdir(join(tmp, '.ssh'), { mode: 0o700, recursive: true });
        const copy = await new Deno.Command('sshpass', {
          env: { HOME: tmp },
          args: [
            '-p',
            'hunter2',
            'ssh-copy-id',
            '-s',
            '-i',
            `${keyFile}.pub`,
            '-p',
            String(port),
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            'bob@127.0.0.1',
          ],
        }).output();
        const copyOut = new TextDecoder().decode(copy.stdout) + new TextDecoder().decode(copy.stderr);
        assertEquals(copy.code, 0, copyOut);

        assertStringIncludes(await runWithKey(port, 'bob', bobKey.private, 'user-whoami'), 'bob');
        const modes = await admin!.execJson<{ mode: number }>('props /home/bob/.ssh/authorized_keys');
        assert((modes.mode & 0o022) === 0, `authorized_keys mode ${modes.mode.toString(8)}`);
      },
    });
  } finally {
    anna?.close();
    admin?.close();
    await harness.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});
