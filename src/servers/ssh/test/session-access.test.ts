/**
 * An SSH session carries the same groups as a shell signed in with `login`:
 * the user node's primary group as well as the groups the user is linked into.
 */

import { assertEquals } from '@std/assert';
import { Client } from 'ssh2';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

/** Log in with a password and run one command, returning what it wrote */
async function runWithPassword(port: number, username: string, password: string, command: string): Promise<string> {
  const client = new Client();
  await client.connect({ host: '127.0.0.1', port, username, password, hostVerifier: () => true, readyTimeout: 10000 });
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

Deno.test({
  name: 'ssh server: a session has the user node primary group',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  const port = primary.sshPort;
  let admin: ShellClient | undefined;

  try {
    admin = await harness.createShellClient();
    // crew is anna's primary group, with no membership link to say so
    await admin.exec('user-create anna && user-passwd anna --new-password secret');
    await admin.exec('group-create crew && user-set-primary-group anna crew');
    await admin.exec('echo aboard > /crew-note && chown admin:crew /crew-note && chmod 040 /crew-note');

    await t.step('the group bits grant to it', async () => {
      assertEquals((await runWithPassword(port, 'anna', 'secret', 'cat /crew-note')).trim(), 'aboard');
    });

    await t.step('what the session creates with its gid gets it', async () => {
      await runWithPassword(port, 'anna', 'secret', 'ln -s /crew-note /home/anna/link');
      const link = (await admin!.exec('stat -L /home/anna/link')).data as { props: { gid: number } };
      const crew = (await admin!.exec('group-info crew')).data as { gid: number };
      assertEquals(link.props.gid, crew.gid);
    });
  } finally {
    admin?.close();
    await harness.stop();
  }
});
