/**
 * The access log: sign-ins and their failures, sign-outs, elevations, share links opened and
 * downloads are recorded with who, the session and the client's address, and read back by
 * `access-log`; a session's writes carry the same session in the audit trail.
 */

import { assert, assertEquals } from '@std/assert';
import type { AccessLogEntry, AuditEntry, ShareLinkCreated } from '../../../../lib/api/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../../testing/mod.ts';

const harness = new SystemTestHarness({ boot: true });

Deno.test({
  name: 'access log',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const instance = await harness.start();
  const clients: ShellClient[] = [];
  const open = async (opts?: { username?: string; password?: string; login?: boolean }) => {
    const client = await harness.createShellClient(opts);
    clients.push(client);
    return client;
  };

  try {
    const admin = await open();
    const cmd = testCommands(admin);
    await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password secret && group-add-member sudo anna');
    await cmd.shouldSucceed('mkdir -p /archive/trip/files && chmod 0777 /archive/trip/files && chmod 0755 / /archive');
    await cmd.shouldSucceed('echo "a sailboat" > /archive/trip/files/boat.txt && chmod 0644 /archive/trip/files/boat.txt');
    const annaUid = (await admin.execJson<{ uid: number }>('attrs /etc/users/anna')).uid;
    const log = (args: string) => admin.execJson<AccessLogEntry[]>(`access-log ${args}`);

    let annaSid = '';

    await t.step('a sign-in is recorded with the account, session, address and origin', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      const [entry] = await log('--user anna --event sign-in -n 1');
      assertEquals(entry.uid, annaUid);
      assertEquals(entry.username, 'anna');
      assertEquals(entry.via, 'web');
      assertEquals(entry.from, '127.0.0.1');
      assert(entry.sid?.startsWith('session-'), `sid ${entry.sid}`);
      annaSid = entry.sid!;

      // What the session writes names it in the audit trail.
      await testCommands(anna).shouldSucceed('mkdir /archive/trip/files/notes');
      const [write] = await admin.execJson<AuditEntry[]>(`audit --sid ${annaSid} -n 1`);
      assertEquals(write.path, '/archive/trip/files/notes');
    });

    await t.step('a failed sign-in names the account it tried, and none for an unknown one', async () => {
      const guest = await open({ login: false });
      await testCommands(guest).shouldFailWith('login anna wrong', 'authentication failed');
      await testCommands(guest).shouldFailWith('login nobody-here wrong', 'authentication failed');

      const [unknown, known] = await log('--event sign-in-failed -n 2');
      assertEquals(known.uid, annaUid);
      assertEquals(known.reason, 'authentication failed');
      assertEquals(unknown.uid, undefined);
      assertEquals(unknown.from, '127.0.0.1');
    });

    await t.step('elevation and its failure are recorded', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldFail('user-elevate --password=wrong');
      await testCommands(anna).shouldSucceed('user-elevate --password=secret');
      const [ok, failed] = await log('--user anna --event elevate --event elevate-failed -n 2');
      assertEquals([ok.event, failed.event], ['elevate', 'elevate-failed']);
    });

    await t.step('a sign-out is recorded as whoever signed out', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldSucceed('logout');
      const [entry] = await log('--event sign-out -n 1');
      assertEquals(entry.uid, annaUid);
    });

    await t.step('a share link opened by a visitor is recorded as the link', async () => {
      const created = await admin.execJson<ShareLinkCreated>('share-link create /archive/trip');
      const guest = await open({ login: false });
      await testCommands(guest).shouldSucceed(`share-link open ${created.link.token}`);

      const [entry] = await log(`--link ${created.link.id}`);
      assertEquals(entry.event, 'link-open');
      assertEquals(entry.path, '/archive/trip');
      assert(entry.uid !== undefined && entry.uid !== annaUid);
    });

    await t.step('a download of an original is recorded once per session, a seek or a rendition not', async () => {
      const { cookie } = await harness.createHttpSession({ uid: annaUid, gid: annaUid, gids: [annaUid] });
      const get = async (path: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`${instance.baseUrl}/file${path}`, { headers: { cookie, ...headers } });
        await res.body?.cancel();
        return res.status;
      };

      assertEquals(await get('/archive/trip/files/boat.txt'), 200);
      assertEquals(await get('/archive/trip/files/boat.txt'), 200);
      assertEquals(await get('/archive/trip/files/boat.txt', { range: 'bytes=4-' }), 206);
      await cmd.shouldSucceed('echo thumb > /archive/trip/files/boat.webp');
      await instance.vfs.update(ADMIN_ACCESS, '/archive/trip/files/boat.webp', { attrs: { sourceId: 'some-original' } });
      assertEquals(await get('/archive/trip/files/boat.webp'), 200);

      const entries = await log('/archive/trip --event download');
      assertEquals(entries.map((entry) => [entry.path, entry.uid, entry.via]), [['/archive/trip/files/boat.txt', annaUid, 'http']]);
    });

    await t.step('a zip of a selection is recorded with its folder and size', async () => {
      const { cookie } = await harness.createHttpSession();
      const posted = await fetch(`${instance.baseUrl}/archive`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ paths: ['/archive/trip/files/boat.txt', '/archive/trip/files/boat.webp'] }),
      });
      const { url } = await posted.json() as { url: string };
      const res = await fetch(`${instance.baseUrl}${url}`, { headers: { cookie } });
      await res.arrayBuffer();

      const [entry] = await log('--event download-archive -n 1');
      assertEquals([entry.path, entry.count], ['/archive/trip/files', 2]);
    });

    await t.step('only an administrator reads the log', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldFail('access-log');
    });

    await t.step('access-log-purge removes what is older than asked', async () => {
      const before = (await log('-n 1000')).length;
      await cmd.shouldSucceed('access-log-purge --older-than 1d');
      assertEquals((await log('-n 1000')).length, before);
      assertEquals(await instance.vfs.accessLogPurge(ADMIN_ACCESS, { before: Date.now() + 1000 }) >= before, true);
      assertEquals((await log('--event download')).length, 0);
    });
  } finally {
    for (const client of clients) client.close();
    await harness.stop();
  }
});
