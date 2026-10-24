/**
 * `ssh`, `scp`, `ssh-keygen` and `ssh-copy-id` against an in-process SSH
 * server (src/testing/ssh-test-server.ts) serving a temp directory.
 *
 * The API shell has no terminal, so nothing here can be asked: host keys are
 * accepted with `-o StrictHostKeyChecking=accept-new` and logins use keys.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { type ShellClient, SystemTestHarness } from '../../../../../testing/mod.ts';
import { type SshTestServer, startSshTestServer } from '../../../../../testing/ssh-test-server.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

function text(result: { data: unknown; error?: string }): string {
  return `${typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')}${result.error ?? ''}`;
}

Deno.test({
  name: 'ssh, scp, ssh-keygen and ssh-copy-id',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'ein-ssh-remote-' });
  let server: SshTestServer | undefined;
  let admin: ShellClient | undefined;
  let anna: ShellClient | undefined;

  await harness.startPrimary();

  try {
    server = await startSshTestServer({
      root,
      exec: (command) => command === 'fail' ? { stderr: 'it failed\n', code: 3 } : { stdout: `ran: ${command}\n` },
    });
    const port = server.port;
    const at = `-o StrictHostKeyChecking=accept-new admin@127.0.0.1`;
    admin = await harness.createShellClient();

    await t.step('ssh-keygen makes a key pair in ~/.ssh', async () => {
      const result = await admin!.exec('ssh-keygen -q -N ""', { json: false });
      assertEquals(result.success, true, text(result));

      const pub = await admin!.exec('cat /home/admin/.ssh/id_ed25519.pub', { json: false });
      assertStringIncludes(text(pub), 'ssh-ed25519 ');
      assertStringIncludes(text(pub), 'admin@ein');

      // The server trusts it from now on
      await Deno.mkdir(join(root, '.ssh'), { recursive: true });
      await Deno.writeTextFile(join(root, '.ssh', 'authorized_keys'), text(pub).trim() + '\n');

      const fp = await admin!.exec('ssh-keygen -l -f /home/admin/.ssh/id_ed25519', { json: false });
      assertStringIncludes(text(fp), '256 SHA256:');
      assertStringIncludes(text(fp), '(ED25519)');
    });

    await t.step('an unknown host is refused when there is no one to ask', async () => {
      const result = await admin!.exec(`ssh -p ${port} admin@127.0.0.1 hello 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'Host key verification failed');
      assertStringIncludes(text(result), 'code=255');
    });

    await t.step('accept-new records the host and runs the command', async () => {
      const result = await admin!.exec(`ssh -p ${port} ${at} hello world 2>&1`, { json: false });
      assertStringIncludes(text(result), 'ran: hello world');
      assertStringIncludes(text(result), `Permanently added '[127.0.0.1]:${port}'`);

      const known = await admin!.exec('cat /home/admin/.ssh/known_hosts', { json: false });
      assertStringIncludes(text(known), `[127.0.0.1]:${port} ssh-ed25519 `);
    });

    await t.step('a known host connects without asking, and the exit status comes back', async () => {
      const ok = await admin!.exec(`ssh -p ${port} admin@127.0.0.1 again`, { json: false });
      assertStringIncludes(text(ok), 'ran: again');

      const failed = await admin!.exec(`ssh -p ${port} admin@127.0.0.1 fail 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(failed), 'it failed');
      assertStringIncludes(text(failed), 'code=3');
    });

    await t.step('~/.ssh/config names a host: HostName, Port and User; -F none reads no file', async () => {
      await admin!.exec(`printf 'Host boat\\n  HostName 127.0.0.1\\n  Port ${port}\\n  User admin\\n' > /home/admin/.ssh/config`, { json: false });

      const ok = await admin!.exec('ssh boat by-alias 2>&1', { json: false });
      assertStringIncludes(text(ok), 'ran: by-alias');

      await Deno.writeTextFile(join(root, 'alias.txt'), 'a harbour\n');
      const copied = await admin!.exec('scp -q boat:alias.txt /home/admin/ 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(copied), 'code=0');
      assertStringIncludes(text(await admin!.exec('cat /home/admin/alias.txt', { json: false })), 'a harbour');

      const none = await admin!.exec('ssh -F none -o ConnectTimeout=2 boat by-alias 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(none), 'code=255');

      await admin!.exec('rm /home/admin/.ssh/config', { json: false });
    });

    await t.step('a changed host key is refused; ssh-keygen -R forgets it', async () => {
      // Another key recorded for the same host
      const other = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
      await admin!.exec(`echo "[127.0.0.1]:${port} ssh-ed25519 ${other}" > /home/admin/.ssh/known_hosts`);

      const refused = await admin!.exec(`ssh -p ${port} ${at} hello 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(refused), 'REMOTE HOST IDENTIFICATION HAS CHANGED');
      assertStringIncludes(text(refused), 'code=255');

      const forget = await admin!.exec(`ssh-keygen -R "[127.0.0.1]:${port}" 2>&1`, { json: false });
      assertStringIncludes(text(forget), 'updated');

      const again = await admin!.exec(`ssh -p ${port} ${at} hello`, { json: false });
      assertStringIncludes(text(again), 'ran: hello');
    });

    await t.step('scp copies a file out', async () => {
      await admin!.exec('echo "a sailboat" > /home/admin/note.txt');
      const result = await admin!.exec(`scp -q -P ${port} /home/admin/note.txt admin@127.0.0.1:up.txt 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'code=0');
      assertEquals(await Deno.readTextFile(join(root, 'up.txt')), 'a sailboat\n');
    });

    await t.step('scp copies a file in the way an upload does', async () => {
      await Deno.writeTextFile(join(root, 'down.txt'), 'a lighthouse\n');
      const result = await admin!.exec(`scp -q -P ${port} admin@127.0.0.1:down.txt /home/admin/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'code=0');

      const content = await admin!.exec('cat /home/admin/down.txt', { json: false });
      assertStringIncludes(text(content), 'a lighthouse');

      // size, checksum and type are recorded, which is what the pipelines react to
      const attrs = await admin!.execJson<{ size: number; sha256?: string; mimetype: string }>('attrs /home/admin/down.txt');
      assertEquals(attrs.size, 13);
      assert(attrs.sha256, 'sha256 recorded');
      assertEquals(attrs.mimetype, 'text/plain');
    });

    await t.step('scp -r copies directories both ways, and expands a remote glob', async () => {
      await Deno.mkdir(join(root, 'album', 'inner'), { recursive: true });
      await Deno.writeTextFile(join(root, 'album', 'a.txt'), 'first');
      await Deno.writeTextFile(join(root, 'album', 'inner', 'b.txt'), 'second');

      const down = await admin!.exec(`scp -r -q -P ${port} admin@127.0.0.1:album /home/admin/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(down), 'code=0');
      assertStringIncludes(text(await admin!.exec('cat /home/admin/album/inner/b.txt', { json: false })), 'second');

      const up = await admin!.exec(`scp -r -q -P ${port} /home/admin/album admin@127.0.0.1:copy 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(up), 'code=0');
      assertEquals(await Deno.readTextFile(join(root, 'copy', 'inner', 'b.txt')), 'second');

      await admin!.exec('mkdir /home/admin/globbed');
      const glob = await admin!.exec(`scp -q -P ${port} "admin@127.0.0.1:album/*.txt" /home/admin/globbed/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(glob), 'code=0');
      assertStringIncludes(text(await admin!.exec('cat /home/admin/globbed/a.txt', { json: false })), 'first');

      // Any segment may hold a pattern; an inner one only matches directories
      await Deno.writeTextFile(join(root, 'album', 'inner.txt'), 'not a directory');
      await admin!.exec('mkdir /home/admin/deep');
      const deep = await admin!.exec(`scp -q -P ${port} "admin@127.0.0.1:al*/in*/*.txt" /home/admin/deep/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(deep), 'code=0');
      assertStringIncludes(text(await admin!.exec('cat /home/admin/deep/b.txt', { json: false })), 'second');

      const none = await admin!.exec(`scp -q -P ${port} "admin@127.0.0.1:al*/none*/*.txt" /home/admin/deep/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(none), 'No match');
      assertStringIncludes(text(none), 'code=1');
    });

    await t.step('scp -p keeps the modification time both ways', async () => {
      const then = new Date('2020-06-01T12:00:00Z');
      await Deno.writeTextFile(join(root, 'old.txt'), 'an old map\n');
      await Deno.utime(join(root, 'old.txt'), then, then);

      const down = await admin!.exec(`scp -p -q -P ${port} admin@127.0.0.1:old.txt /home/admin/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(down), 'code=0');
      const attrs = await admin!.execJson<{ writtenAt?: string }>('attrs /home/admin/old.txt');
      assertEquals(attrs.writtenAt, then.toISOString());

      const up = await admin!.exec(`scp -p -q -P ${port} /home/admin/old.txt admin@127.0.0.1:old-again.txt 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(up), 'code=0');
      assertEquals((await Deno.stat(join(root, 'old-again.txt'))).mtime?.toISOString(), then.toISOString());
    });

    await t.step('ssh-copy-id installs a key once', async () => {
      await admin!.exec('ssh-keygen -q -t ecdsa -N "" -f /home/admin/.ssh/second');

      const first = await admin!.exec(`ssh-copy-id -i /home/admin/.ssh/second -p ${port} admin@127.0.0.1 2>&1`, { json: false });
      assertStringIncludes(text(first), 'Number of key(s) added: 1');
      const keys = await Deno.readTextFile(join(root, '.ssh', 'authorized_keys'));
      assertEquals(keys.trim().split('\n').length, 2);

      const again = await admin!.exec(`ssh-copy-id -i /home/admin/.ssh/second -p ${port} admin@127.0.0.1 2>&1`, { json: false });
      assertStringIncludes(text(again), 'already exist');
      assertEquals((await Deno.readTextFile(join(root, '.ssh', 'authorized_keys'))).trim().split('\n').length, 2);

      // The new key alone logs in
      const login = await admin!.exec(`ssh -i /home/admin/.ssh/second -p ${port} admin@127.0.0.1 with-second`, { json: false });
      assertStringIncludes(text(login), 'ran: with-second');
    });

    await t.step('only members of group ssh may connect', async () => {
      await admin!.exec('user-create anna && user-passwd anna --new-password secret');
      anna = await harness.createShellClient({ username: 'anna', password: 'secret' });

      const refused = await anna.exec(`ssh -p ${port} ${at} hello 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(refused), "must be a member of group 'ssh'");
      assertStringIncludes(text(refused), 'code=255');

      const scpRefused = await anna.exec(`scp -P ${port} admin@127.0.0.1:down.txt /home/anna/ 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(scpRefused), "must be a member of group 'ssh'");

      await admin!.exec('group-add-member ssh anna');
      anna.close();
      anna = await harness.createShellClient({ username: 'anna', password: 'secret' });

      // A member gets as far as needing a key of her own
      const noKey = await anna.exec(`ssh -p ${port} ${at} hello 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(noKey), 'Permission denied');
    });
  } finally {
    anna?.close();
    admin?.close();
    await server?.close();
    await harness.stop();
    await Deno.remove(root, { recursive: true });
  }
});
