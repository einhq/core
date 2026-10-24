/**
 * `mount <path> sftp …`, `--save`, `mount -a` and `unmount --save`, against an
 * in-process SFTP server serving a temp directory.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { fingerprint } from '../../../../../lib/ssh/mod.ts';
import { type ShellClient, SystemTestHarness } from '../../../../../testing/mod.ts';
import { type SshTestServer, startSshTestServer } from '../../../../../testing/ssh-test-server.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

function text(result: { data: unknown; error?: string }): string {
  return `${typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')}${result.error ?? ''}`;
}

Deno.test({
  name: 'mount sftp',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'ein-mount-sftp-' });
  await Deno.mkdir(join(root, 'share', 'album'), { recursive: true });
  await Deno.writeTextFile(join(root, 'share', 'notes.txt'), 'a sailboat\n');
  await Deno.writeTextFile(join(root, 'share', 'album', 'a.txt'), 'a lighthouse\n');

  let server: SshTestServer | undefined;
  let admin: ShellClient | undefined;
  await harness.startPrimary();

  try {
    server = await startSshTestServer({ root });
    const port = server.port;
    const pinned = await fingerprint(server.hostKey);
    admin = await harness.createShellClient();

    // The admin's key is what the mount logs in with
    await admin.exec('ssh-keygen -q -N ""', { json: false });
    const pub = text(await admin.exec('cat /home/admin/.ssh/id_ed25519.pub', { json: false })).trim();
    await Deno.mkdir(join(root, '.ssh'));
    await Deno.writeTextFile(join(root, '.ssh', 'authorized_keys'), `${pub}\n`);
    await admin.exec('mkdir -p /mnt/nas /mnt/known /mnt/down');

    const opts = `host=127.0.0.1,port=${port},path=share`;

    await t.step('an unknown host key is refused when there is no one to ask', async () => {
      const result = await admin!.exec(`mount /mnt/nas sftp "${opts}" 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'Host key verification failed');
      assertStringIncludes(text(result), 'code=1');
    });

    await t.step('a pinned host key mounts the remote directory', async () => {
      const result = await admin!.exec(`mount /mnt/nas sftp "${opts},hostkey=${pinned}" 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'code=0');

      assertStringIncludes(text(await admin!.exec('ls /mnt/nas', { json: false })), 'notes.txt');
      assertStringIncludes(text(await admin!.exec('cat /mnt/nas/album/a.txt', { json: false })), 'a lighthouse');

      const mounts = await admin!.execJson<{ path: string; type: string; source?: string }[]>('mount');
      const nas = mounts.find((m) => m.path === '/mnt/nas');
      assertEquals(nas?.type, 'sftp');
      assertEquals(nas?.source, 'admin@127.0.0.1:share');
    });

    await t.step('writes land on the server', async () => {
      await admin!.exec('echo "a harbour" > /mnt/nas/written.txt');
      assertEquals(await Deno.readTextFile(join(root, 'share', 'written.txt')), 'a harbour\n');

      await admin!.exec('mkdir /mnt/nas/new-album && mv /mnt/nas/written.txt /mnt/nas/new-album/');
      assertEquals(await Deno.readTextFile(join(root, 'share', 'new-album', 'written.txt')), 'a harbour\n');

      await admin!.exec('rm /mnt/nas/new-album/written.txt');
      assertEquals((await Array.fromAsync(Deno.readDir(join(root, 'share', 'new-album')))).length, 0);
    });

    await t.step('a host in known_hosts needs no pin', async () => {
      await admin!.exec(`ssh -o StrictHostKeyChecking=accept-new -p ${port} admin@127.0.0.1 hello`, { json: false });
      const result = await admin!.exec(`mount /mnt/known sftp "${opts}" 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'code=0');
      assertStringIncludes(text(await admin!.exec('ls /mnt/known', { json: false })), 'notes.txt');
      await admin!.exec('unmount /mnt/known');
    });

    await t.step('--save records it, mount -a brings it back, unmount --save forgets it', async () => {
      await admin!.exec('unmount /mnt/nas');
      const saved = await admin!.exec(`mount --save /mnt/nas sftp "${opts}" 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(saved), 'code=0');
      assertStringIncludes(text(await admin!.exec('cat /etc/fstab', { json: false })), `/mnt/nas sftp ${opts}`);

      await admin!.exec('unmount /mnt/nas');
      const all = await admin!.exec('mount -a 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(all), 'code=0');
      assertStringIncludes(text(await admin!.exec('ls /mnt/nas', { json: false })), 'notes.txt');

      await admin!.exec('unmount --save /mnt/nas');
      assert(!text(await admin!.exec('cat /etc/fstab', { json: false })).includes('/mnt/nas'));
    });

    await t.step('mount -a does not wait for a server that does not answer', async () => {
      // Nothing listens on a port that was just freed
      const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
      const deadPort = (listener.addr as Deno.NetAddr).port;
      listener.close();

      await admin!.exec(`echo "/mnt/down sftp host=127.0.0.1,port=${deadPort},hostkey=${pinned}" > /etc/fstab`);
      const started = Date.now();
      const all = await admin!.exec('mount -a 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(all), 'code=0');
      assert(Date.now() - started < 5000, 'mount -a returned promptly');

      const listing = await admin!.exec('ls /mnt/down 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(listing), 'refused');
      await admin!.exec('unmount /mnt/down');
    });
  } finally {
    admin?.close();
    await server?.close();
    await harness.stop();
    await Deno.remove(root, { recursive: true });
  }
});
