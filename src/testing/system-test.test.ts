/**
 * System Integration Tests
 *
 * End-to-end tests with a primary instance (HTTP + SSH).
 * Tests SFTP upload and SSH command execution.
 */

import { SESSIONS_PATH } from '../lib/paths.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../lib/access/mod.ts';
import { SystemTestHarness } from './system-test-harness.ts';

const harness = new SystemTestHarness();

Deno.test({
  name: 'System integration',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();

  try {
    await t.step('servers keep the ports reserved by their own listeners', () => {
      assertEquals(primary.httpPort > 0, true);
      assertEquals(primary.sshPort > 0, true);
      assertEquals(primary.httpPort === primary.sshPort, false);
    });

    // -- SFTP tests --

    await t.step('sftp: upload and download file', async () => {
      const { client, sftp } = await harness.connectSFTP();

      try {
        const data = new TextEncoder().encode('hello from sftp');
        await sftp.writeFile('/home/admin/test.txt', data);

        const downloaded = await sftp.readFile('/home/admin/test.txt');
        assertEquals(new TextDecoder().decode(downloaded), 'hello from sftp');
      } finally {
        client.end();
      }
    });

    await t.step('sftp: file stat returns correct size', async () => {
      const { client, sftp } = await harness.connectSFTP();

      try {
        const data = new TextEncoder().encode('stat test content');
        await sftp.writeFile('/home/admin/stat-test.txt', data);

        const stats = await sftp.stat('/home/admin/stat-test.txt');
        assertEquals(stats.size, data.length);
      } finally {
        client.end();
      }
    });

    await t.step('sftp: create directory', async () => {
      const { client, sftp } = await harness.connectSFTP();

      try {
        await sftp.mkdir('/home/admin/photos');

        const stats = await sftp.stat('/home/admin/photos');
        assertEquals((stats.mode! & 0o40000) !== 0, true); // is directory
      } finally {
        client.end();
      }
    });

    await t.step('sftp: upload files into directory', async () => {
      const { client, sftp } = await harness.connectSFTP();
      const enc = new TextEncoder();

      try {
        await sftp.writeFile('/home/admin/photos/a.jpg', enc.encode('img-a'));
        await sftp.writeFile('/home/admin/photos/b.jpg', enc.encode('img-b'));

        // Verify files exist via stat
        const statsA = await sftp.stat('/home/admin/photos/a.jpg');
        assertEquals(statsA.size, 5);
        const statsB = await sftp.stat('/home/admin/photos/b.jpg');
        assertEquals(statsB.size, 5);
      } finally {
        client.end();
      }
    });

    // -- SSH exec tests --

    await t.step('ssh: exec ls on root', async () => {
      const result = await harness.runSSH('ls /');
      assertEquals(result.code, 0);
      assertStringIncludes(result.stdout, 'home');
      assertStringIncludes(result.stdout, 'usr');
      assertStringIncludes(result.stdout, 'tmp');
    });

    await t.step('ssh: exec ls shows uploaded files', async () => {
      const result = await harness.runSSH('ls /home/admin');
      assertEquals(result.code, 0);
      assertStringIncludes(result.stdout, 'test.txt');
      assertStringIncludes(result.stdout, 'photos');
    });

    await t.step('ssh: exec cat reads uploaded file', async () => {
      const result = await harness.runSSH('cat /home/admin/test.txt');
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), 'hello from sftp');
    });

    await t.step('ssh: exec stat on file', async () => {
      const result = await harness.runSSH('stat /home/admin/test.txt');
      assertEquals(result.code, 0);
      assertStringIncludes(result.stdout, 'file');
    });

    await t.step('ssh: exec leaves no session node behind', async () => {
      const vfs = harness.primary!.vfs;
      const sshSessions = async () => {
        const children = await vfs.children(ADMIN_ACCESS, SESSIONS_PATH);
        return children.filter((c) => c.name.startsWith('session-ssh-')).length;
      };

      // Every exec channel creates its own session, and closing the channel removes it.
      const before = await sshSessions();
      for (let i = 0; i < 3; i++) {
        assertEquals((await harness.runSSH('pwd')).code, 0);
      }

      // The unlink happens in the channel's finally, which can land just after
      // the client sees the exit status.
      for (let i = 0; i < 40 && await sshSessions() > before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assertEquals(await sshSessions(), before);
    });
  } finally {
    await harness.stop();
  }
});
