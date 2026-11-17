/**
 * File tickets: one path read with the access it was made with, until it runs out unless renewed;
 * and over HTTP, a file read with a ticket and no session, from any page, with what a DLNA renderer
 * asks of how it may read it, and nothing else read with it.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS, GUEST_ACCESS } from '../../../lib/access/constants.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { FILE_TICKET_TTL_MS, FileTickets } from '../file-tickets.ts';

Deno.test('a file ticket reads its path alone, until it runs out unless renewed', () => {
  const tickets = new FileTickets();
  const ticket = tickets.issue('/music/song.m4a', ADMIN_ACCESS, 0);
  assertEquals(tickets.access(ticket, '/music/song.m4a', 1), ADMIN_ACCESS);
  assertEquals(tickets.access(ticket, '/music/other.m4a', 1), undefined);
  assertEquals(tickets.access('nothing', '/music/song.m4a', 1), undefined);

  assertEquals(tickets.renew(ticket, FILE_TICKET_TTL_MS - 1), true);
  assertEquals(tickets.access(ticket, '/music/song.m4a', 2 * FILE_TICKET_TTL_MS - 2), ADMIN_ACCESS);
  assertEquals(tickets.access(ticket, '/music/song.m4a', 2 * FILE_TICKET_TTL_MS), undefined);
  assertEquals(tickets.renew(ticket, 2 * FILE_TICKET_TTL_MS), false);

  const dropped = tickets.issue('/music/song.m4a', ADMIN_ACCESS, 0);
  tickets.drop(dropped);
  assertEquals(tickets.access(dropped, '/music/song.m4a', 1), undefined);
});

const harness = new SystemTestHarness({ ssh: false });

Deno.test({ name: 'a file read with a ticket over HTTP', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  const bytes = new TextEncoder().encode('a song, as bytes');
  for (const name of ['song.m4a', 'other.m4a']) {
    await vfs.create(ADMIN_ACCESS, 'file', '/tmp', name, { attrs: { name, mimetype: 'audio/mp4' }, props: { mode: 0o600 } });
    const handle = await vfs.open(ADMIN_ACCESS, `/tmp/${name}`, { mode: 'w' });
    await handle.write(bytes);
    await handle.close();
  }

  try {
    await t.step('only someone who may read the file gets a ticket for it', async () => {
      await assertRejects(() => devices.fileTicket(GUEST_ACCESS, '/tmp/song.m4a'));
      await assertRejects(() => devices.fileTicket(ADMIN_ACCESS, '/tmp'), Error, 'not a file');
    });

    const ticket = await devices.fileTicket(ADMIN_ACCESS, '/tmp/song.m4a');

    await t.step('the ticket reads the file without a session, for any page', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/song.m4a?ticket=${ticket}`);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get('access-control-allow-origin'), '*');
      assertEquals(new Uint8Array(await res.arrayBuffer()), bytes);

      const ranged = await fetch(`${baseUrl}/file/tmp/song.m4a?ticket=${ticket}`, { headers: { range: 'bytes=2-5' } });
      assertEquals(ranged.status, 206);
      assertEquals(await ranged.text(), 'song');

      const dlna = await fetch(`${baseUrl}/file/tmp/song.m4a?ticket=${ticket}`, {
        method: 'HEAD',
        headers: { 'getcontentFeatures.dlna.org': '1', 'transferMode.dlna.org': 'Streaming' },
      });
      assertEquals(dlna.status, 200);
      assertEquals(dlna.headers.get('contentfeatures.dlna.org')?.startsWith('DLNA.ORG_OP=01;'), true);
      assertEquals(dlna.headers.get('transfermode.dlna.org'), 'Streaming');

      const preflight = await fetch(`${baseUrl}/file/tmp/song.m4a?ticket=${ticket}`, { method: 'OPTIONS' });
      await preflight.body?.cancel();
      assertEquals(preflight.status, 204);
      assertEquals(preflight.headers.get('access-control-allow-origin'), '*');
    });

    await t.step('it reads no other file, and nothing once dropped', async () => {
      const other = await fetch(`${baseUrl}/file/tmp/other.m4a?ticket=${ticket}`);
      await other.body?.cancel();
      assertEquals(other.status, 403);
      const unticketed = await fetch(`${baseUrl}/file/tmp/song.m4a`);
      await unticketed.body?.cancel();
      assertEquals(unticketed.status, 401);

      assertEquals(devices.renewFileTicket(ticket), true);
      devices.dropFileTicket(ticket);
      const dropped = await fetch(`${baseUrl}/file/tmp/song.m4a?ticket=${ticket}`);
      await dropped.body?.cancel();
      assertEquals(dropped.status, 403);
      assertEquals(devices.renewFileTicket(ticket), false);
    });
  } finally {
    await harness.stop();
  }
});
