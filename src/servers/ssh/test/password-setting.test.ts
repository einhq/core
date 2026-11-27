/**
 * `CFG_SSH_PASSWORD_AUTH` off: the SSH server offers keys alone and refuses a password, even one a
 * client sends after passwords were offered; a key still signs in, and on again a password does.
 *
 * The step that reads what the server offers drives OpenSSH's `ssh` and is skipped where it is not
 * installed.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { Client, type ClientConfig, generateKeyPair } from 'ssh2';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

async function have(tool: string): Promise<boolean> {
  try {
    return (await new Deno.Command('which', { args: [tool], stdout: 'null', stderr: 'null' }).output()).success;
  } catch {
    return false;
  }
}

/** Sign in and run `user-whoami`; rejects when sign-in fails. */
async function whoami(port: number, config: ClientConfig): Promise<string> {
  const client = new Client();
  await client.connect({ host: '127.0.0.1', port, hostVerifier: () => true, readyTimeout: 10000, ...config });
  try {
    const channel = await client.exec('user-whoami');
    let out = '';
    const decoder = new TextDecoder();
    for await (const chunk of channel.readable) out += decoder.decode(chunk, { stream: true });
    return out;
  } finally {
    client.end();
  }
}

Deno.test({
  name: 'ssh server: passwords can be turned off',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const instance = await harness.start();
  const port = instance.sshPort;
  let admin: ShellClient | undefined;
  const key = await generateKeyPair('ed25519', { comment: 'anna@laptop' });

  /** The methods OpenSSH's `ssh` is told it may use, as its `Permission denied (…)` names them. */
  const offered = async (): Promise<string> => {
    const out = await new Deno.Command('ssh', {
      args: [
        '-p',
        String(port),
        '-o',
        'BatchMode=yes',
        '-o',
        'PreferredAuthentications=none',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'LogLevel=ERROR',
        'anna@127.0.0.1',
        'true',
      ],
    }).output();
    return new TextDecoder().decode(out.stderr);
  };

  try {
    admin = await harness.createShellClient();
    await admin.exec('user-create anna && user-passwd anna --new-password secret');
    await admin.exec('mkdir -p /home/anna/.ssh && chown anna /home/anna/.ssh && chmod 700 /home/anna/.ssh');
    await admin.exec(`echo "${key.public}" > /home/anna/.ssh/authorized_keys`);
    await admin.exec('chown anna /home/anna/.ssh/authorized_keys && chmod 600 /home/anna/.ssh/authorized_keys');

    await t.step('on by default: a password signs in', async () => {
      assertStringIncludes(await whoami(port, { username: 'anna', password: 'secret' }), 'anna');
    });

    await t.step('off: a password is refused, a key signs in', async () => {
      await admin!.exec('config set CFG_SSH_PASSWORD_AUTH false');
      await assertRejects(() => whoami(port, { username: 'anna', password: 'secret' }));
      assertStringIncludes(await whoami(port, { username: 'anna', privateKey: key.private }), 'anna');
    });

    await t.step({
      name: 'off, passwords are not offered',
      ignore: !await have('ssh'),
      fn: async () => {
        assertStringIncludes(await offered(), 'Permission denied (publickey).');
        await admin!.exec('config set CFG_SSH_PASSWORD_AUTH true');
        assertStringIncludes(await offered(), 'Permission denied (publickey,password).');
      },
    });

    await t.step('a password sent after passwords were turned off is refused', async () => {
      await admin!.exec('config set CFG_SSH_PASSWORD_AUTH true');
      let asked = 0;
      // Asked once the server has offered passwords: turned off before the password is sent
      const password = async () => {
        if (asked++ > 0) return false;
        await admin!.exec('config set CFG_SSH_PASSWORD_AUTH false');
        return 'secret';
      };
      await assertRejects(() => whoami(port, { username: 'anna', password }));
      assertEquals(asked, 1);
    });

    await t.step('on again: a password signs in', async () => {
      await admin!.exec('config unset CFG_SSH_PASSWORD_AUTH');
      assertStringIncludes(await whoami(port, { username: 'anna', password: 'secret' }), 'anna');
    });
  } finally {
    admin?.close();
    await harness.stop();
  }
});
