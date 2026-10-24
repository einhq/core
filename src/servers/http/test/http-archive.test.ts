/**
 * Bulk download: POST /archive parks a selection, GET /archive/<token> streams it as one
 * zip. Covers ticket lifetime, name collisions, access, and that the bytes read back.
 */

import { assertEquals } from '@std/assert';
import { BlobReader, TextWriter, ZipReader } from '@zip-js/zip-js';
import { ADMIN_ACCESS, GUEST_GID, GUEST_UID } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { ARCHIVE_MAX_ENTRIES, ARCHIVE_TICKET_TTL_MS, ArchiveTicketStore } from '../archive-tickets.ts';

const harness = new SystemTestHarness({ ssh: false });

/** Every entry of a zip response, as `name -> text`, in the order they were written. */
async function readZip(res: Response): Promise<{ names: string[]; contents: Record<string, string> }> {
  const reader = new ZipReader(new BlobReader(await res.blob()));
  const entries = await reader.getEntries();

  const names: string[] = [];
  const contents: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.directory) continue;
    names.push(entry.filename);
    contents[entry.filename] = await entry.getData(new TextWriter());
  }

  await reader.close();
  return { names, contents };
}

Deno.test({
  name: 'HTTP archive endpoints',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs } = await harness.startPrimary();
  const { cookie } = await harness.createHttpSession();

  const put = async (path: string, body: string) => {
    const res = await fetch(`${baseUrl}/file${path}`, { method: 'PUT', headers: { cookie }, body });
    assertEquals(res.status, 201);
    await res.json();
  };

  const post = (paths: string[], name?: string) =>
    fetch(`${baseUrl}/archive`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, name }),
    });

  try {
    // PUT creates the file node, not the path above it — the selections this endpoint
    // serves come out of albums, so the entries have to sit in separate directories.
    for (const dir of ['alpha', 'beta']) {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/tmp', dir, { props: { mode: 0o755 } });
    }

    await put('/tmp/alpha/one.txt', 'first');
    await put('/tmp/alpha/two.txt', 'second');
    await put('/tmp/beta/one.txt', 'third');

    await t.step('POST parks a selection and GET streams it as a zip', async () => {
      const res = await post(['/tmp/alpha/one.txt', '/tmp/alpha/two.txt']);
      assertEquals(res.status, 200);

      const ticket = await res.json();
      assertEquals(ticket.count, 2);
      assertEquals(ticket.url.startsWith('/archive/'), true);
      assertEquals(ticket.expiresAt > Date.now(), true);

      const zipRes = await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie } });
      assertEquals(zipRes.status, 200);
      assertEquals(zipRes.headers.get('content-type'), 'application/zip');
      assertEquals(zipRes.headers.get('cache-control'), 'no-store');

      const { names, contents } = await readZip(zipRes);
      assertEquals(names, ['one.txt', 'two.txt']);
      assertEquals(contents['one.txt'], 'first');
      assertEquals(contents['two.txt'], 'second');
    });

    // A selection crosses albums, so the same basename twice is ordinary. Two identical
    // names in one zip extract as one file, so the second has to be renamed.
    await t.step('a repeated basename is disambiguated rather than overwritten', async () => {
      const ticket = await (await post(['/tmp/alpha/one.txt', '/tmp/beta/one.txt'])).json();
      const { names, contents } = await readZip(await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie } }));

      assertEquals(names, ['one.txt', 'one (2).txt']);
      assertEquals(contents['one.txt'], 'first');
      assertEquals(contents['one (2).txt'], 'third');
    });

    await t.step('the archive is named by the caller, and the name is reduced to one safe segment', async () => {
      const named = await (await post(['/tmp/alpha/one.txt'], 'Sommaren 2024')).json();
      assertEquals(named.filename, 'Sommaren 2024.zip');

      const res = await fetch(`${baseUrl}${named.url}`, { headers: { cookie } });
      const disposition = res.headers.get('content-disposition')!;
      assertEquals(disposition.includes('filename="Sommaren 2024.zip"'), true);
      assertEquals(disposition.includes(`filename*=UTF-8''${encodeURIComponent('Sommaren 2024.zip')}`), true);
      await res.body?.cancel();

      // A name off the wire ends up in a header and then on someone's disk
      const hostile = await (await post(['/tmp/alpha/one.txt'], '../../etc/pa"sswd')).json();
      assertEquals(hostile.filename.includes('/'), false);
      assertEquals(hostile.filename.includes('"'), false);
    });

    await t.step('an unnamed archive falls back to a dated default', async () => {
      const ticket = await (await post(['/tmp/alpha/one.txt'])).json();
      assertEquals(/^ein-\d{8}-\d{6}\.zip$/.test(ticket.filename), true);
    });

    // The zip is streamed, so by download time there is no status code left to fail with:
    // an unreadable path has to be rejected while the POST can still answer.
    await t.step('POST rejects a selection it cannot read, naming the path', async () => {
      const missing = await post(['/tmp/alpha/one.txt', '/tmp/alpha/gone.txt']);
      assertEquals(missing.status, 404);
      assertEquals((await missing.text()).includes('/tmp/alpha/gone.txt'), true);

      const directory = await post(['/tmp/alpha']);
      assertEquals(directory.status, 400);
      await directory.body?.cancel();

      const empty = await post([]);
      assertEquals(empty.status, 400);
      await empty.body?.cancel();

      const tooMany = await post(new Array(ARCHIVE_MAX_ENTRIES + 1).fill('/tmp/alpha/one.txt'));
      assertEquals(tooMany.status, 413);
      await tooMany.body?.cancel();
    });

    // The token names a list; it is not a capability. The download resolves every path as
    // the session fetching it, so a leaked token grants nothing GET /file would not.
    await t.step('the download re-checks access as the session presenting the token', async () => {
      // 0o700 and admin-owned: someone else cannot traverse into it, so the refusal happens at
      // download time, under a session that is not the one that posted the selection.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/tmp', 'closed', { props: { mode: 0o700 } });
      await put('/tmp/closed/private.txt', 'admin only');
      const ticket = await (await post(['/tmp/closed/private.txt'])).json();

      const { cookie: otherCookie } = await harness.createHttpSession({ uid: 3000, gid: 3000, gids: [3000] });
      const otherRes = await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie: otherCookie } });
      assertEquals(otherRes.status, 403);
      assertEquals((await otherRes.text()).includes('/tmp/closed/private.txt'), true);

      // The guest of an archive that asks visitors to sign in is refused before the list is read.
      const { cookie: guestCookie } = await harness.createHttpSession({ uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] });
      const guestRes = await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie: guestCookie } });
      assertEquals(guestRes.status, 401);
      await guestRes.body?.cancel();

      // ...and the same ticket still works for the session that posted it. A ticket is not
      // consumed by being used: a download that dies on the network is retried against the
      // same URL, and single use would turn a dropped connection into a dead link.
      const ownerZip = await readZip(await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie } }));
      assertEquals(ownerZip.contents['private.txt'], 'admin only');
    });

    // The archive is streamed, so a file discovered missing halfway through can only be
    // reported as a broken download. Resolving the list first keeps it a status code.
    await t.step('a file that went away since the POST is a 404, not a short archive', async () => {
      const ticket = await (await post(['/tmp/alpha/one.txt', '/tmp/beta/one.txt'])).json();
      await vfs.unlink(ADMIN_ACCESS, '/tmp/beta/one.txt', '/tmp/beta');

      const res = await fetch(`${baseUrl}${ticket.url}`, { headers: { cookie } });
      assertEquals(res.status, 404);
      assertEquals((await res.text()).includes('/tmp/beta/one.txt'), true);
    });

    await t.step('an unknown or expired token is a 404', async () => {
      const res = await fetch(`${baseUrl}/archive/deadbeef`, { headers: { cookie } });
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });
  } finally {
    await harness.stop();
  }
});

// The TTL is what keeps a parked selection from being a permanent handle on a list of paths.
// Exercised against an injected clock rather than by waiting out five minutes.
Deno.test('archive tickets expire and are swept', () => {
  const store = new ArchiveTicketStore();
  const start = 1_000_000;
  const entries = [{ path: '/tmp/one.txt', name: 'one.txt', modified: start }];

  const { token } = store.issue(entries, 'x.zip', start);

  assertEquals(store.get(token, start + ARCHIVE_TICKET_TTL_MS - 1)?.entries, entries);
  assertEquals(store.get(token, start + ARCHIVE_TICKET_TTL_MS), undefined);

  // ...and it is gone rather than merely hidden: a ticket that outlived its window must not
  // come back for a caller whose clock reads earlier.
  assertEquals(store.get(token, start), undefined);
});
