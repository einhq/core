/**
 * Unlisted trees are left out of the library's views: the feed and a seek into it, its facets and
 * the `facets` command, a subject's media, a region; `--within` the tree, or a place inside it,
 * still lists what it holds, and `--within` a directory above it leaves it out. Marking and
 * unmarking a directory takes effect on the next search. `unlistedIds` names the nodes that lie in
 * one.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';
import { isUnlistedPath, UNLISTED_ATTR, unlistedIds, unlistedRoots, unlistedWithin } from '../unlisted.ts';

const testCtx = createTestContext({ boot: true });

type Results = { results: { path: string }[]; cursor: string | null };
type Facets = { total: number; days: { key: string; count: number }[]; kinds: { kind: string; count: number }[] };
type YearFacets = { total: number; years: { year: number; count: number }[] };

const names = (r: Results) => r.results.map((hit) => hit.path.split('/').pop()).sort();

const STAGING = '/home/anna/staging';
const INBOX = `${STAGING}/files/inbox`;

Deno.test('which paths a view leaves out', () => {
  const roots = ['/home/anna/staging', '/home/bo/staging'];
  assertEquals(isUnlistedPath(roots, '/home/anna/staging'), true);
  assertEquals(isUnlistedPath(roots, '/home/anna/staging/files/a.jpg'), true);
  assertEquals(isUnlistedPath(roots, '/home/anna/staging-old/a.jpg'), false);
  assertEquals(unlistedWithin(roots), roots);
  assertEquals(unlistedWithin(roots, '/'), roots);
  assertEquals(unlistedWithin(roots, '/home/anna'), ['/home/anna/staging']);
  assertEquals(unlistedWithin(roots, '/home/anna/staging'), []);
  assertEquals(unlistedWithin(roots, '/home/anna/staging/files'), []);
  assertEquals(unlistedWithin(roots, '/archive'), []);
});

Deno.test({
  name: 'an unlisted tree is out of library views',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkmedia = async (path: string, takenAt: string, point?: { lat: number; lng: number }) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    const node = await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...captureTime(takenAt) } });
    if (point) {
      await vfs.create(ADMIN_ACCESS, 'position', path, 'position');
      const handle = await vfs.open(ADMIN_ACCESS, `${path}/position`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify(point)));
      } finally {
        await handle.close();
      }
    }
    return node.id;
  };

  try {
    await cmd.shouldSucceed(`mkdir -p /library/2010 ${INBOX}/upload-2026-10-18`);
    const listed = await mkmedia('/library/2010/harbour.jpg', '2010-06-01T10:00:00', { lat: 57.7, lng: 11.95 });
    await mkmedia('/library/2010/meadow.jpg', '2010-07-01T10:00:00');
    const staged = await mkmedia(`${INBOX}/upload-2026-10-18/boat.jpg`, '2011-06-01T10:00:00', { lat: 57.71, lng: 11.96 });
    await mkmedia(`${INBOX}/scan.jpg`, '2010-06-15T10:00:00');
    await vfs.update(ADMIN_ACCESS, STAGING, { attrs: { [UNLISTED_ATTR]: true } });

    // A subject command answering with the media of a subject, staged and not: what a module's
    // `subject-<kind>` does for a person on both.
    const bin = `/tmp/unlisted-${crypto.randomUUID()}`;
    await cmd.shouldSucceed(`mkdir -p ${bin}`);
    const answer = JSON.stringify({ subjects: [{ ref: 'anna', path: '/people/anna', ids: [listed, staged] }] });
    await vfs.create(ADMIN_ACCESS, 'file', bin, 'subject-friend', { props: { mode: 0o755 } });
    const script = await vfs.open(ADMIN_ACCESS, `${bin}/subject-friend`, { mode: 'w' });
    try {
      await script.write(new TextEncoder().encode(`#!bash\necho '${answer}'\n`));
    } finally {
      await script.close();
    }
    const withSubject = `PATH=${bin}:$PATH`;

    await t.step('the roots are found, with nothing under another', async () => {
      await cmd.shouldSucceed(`mkdir -p ${STAGING}/files/nested`);
      await vfs.update(ADMIN_ACCESS, `${STAGING}/files/nested`, { attrs: { [UNLISTED_ATTR]: true } });
      assertEquals(await unlistedRoots(vfs), [STAGING]);
    });

    await t.step('the feed lists the library only, newest first and from a seek', async () => {
      assertEquals(names(await client.execJson<Results>('search --sort -time')), ['harbour.jpg', 'meadow.jpg']);
      const seeked = await client.execJson<Results>('search --sort -time --at 2011-12');
      assertEquals(names(seeked), ['harbour.jpg', 'meadow.jpg']);
      assertEquals(names(await client.execJson<Results>('search --kind photo --from 2011 --to 2011')), []);
    });

    await t.step('facets count the library only', async () => {
      const facets = await client.execJson<Facets>('search --facets');
      assertEquals(facets.total, 2);
      assertEquals(facets.days.map((day) => day.key), ['2010-06-01', '2010-07-01']);
      const years = await client.execJson<YearFacets>('facets --kind photo');
      assertEquals(years.total, 2);
      assertEquals(years.years, [{ year: 2010, count: 2 }]);
    });

    await t.step("a subject's media are the library's", async () => {
      assertEquals(names(await client.execJson<Results>(`${withSubject} search --subject friend:anna`)), ['harbour.jpg']);
      assertEquals((await client.execJson<Facets>(`${withSubject} search --subject friend:anna --facets`)).total, 1);
    });

    await t.step('a region holds the library only', async () => {
      assertEquals(names(await client.execJson<Results>('search --bbox=57.8,57.6,12.1,11.8')), ['harbour.jpg']);
    });

    await t.step('--within the tree, or a place in it, lists it', async () => {
      assertEquals(names(await client.execJson<Results>(`search --within ${STAGING}`)), ['boat.jpg', 'scan.jpg']);
      assertEquals(names(await client.execJson<Results>(`search --within ${INBOX}/upload-2026-10-18`)), ['boat.jpg']);
      assertEquals((await client.execJson<Facets>(`search --within ${INBOX} --facets`)).total, 2);
    });

    await t.step('--within a directory above it leaves it out', async () => {
      await mkmedia('/home/anna/portrait.jpg', '2012-01-01T10:00:00');
      assertEquals(names(await client.execJson<Results>('search --within /home/anna')), ['portrait.jpg']);
      assertEquals((await client.execJson<Facets>('search --within /home/anna --facets')).total, 1);
    });

    await t.step('unlistedIds names the nodes in an unlisted tree, read either way round', async () => {
      // Two asked of a tree of six: by the parents of what was asked.
      assertEquals(await unlistedIds(vfs, [listed, staged]), new Set([staged]));
      // Ten asked: by the tree's members.
      const more = [];
      for (let i = 0; i < 8; i++) more.push(await mkmedia(`/library/2010/extra-${i}.jpg`, '2010-08-01T10:00:00'));
      assertEquals(await unlistedIds(vfs, [listed, staged, ...more]), new Set([staged]));
    });

    await t.step('unmarking lists the tree again at once, and marking hides it', async () => {
      await vfs.update(ADMIN_ACCESS, STAGING, { attrs: { [UNLISTED_ATTR]: null } });
      assertEquals(await unlistedRoots(vfs), [`${STAGING}/files/nested`]);
      assertEquals(names(await client.execJson<Results>('search --kind photo --from 2011 --to 2011')), ['boat.jpg']);
      await vfs.update(ADMIN_ACCESS, STAGING, { attrs: { [UNLISTED_ATTR]: true } });
      assertEquals(names(await client.execJson<Results>('search --kind photo --from 2011 --to 2011')), []);
    });

    await t.step('a moved tree is left out where it went', async () => {
      await cmd.shouldSucceed('mkdir -p /home/bo');
      await cmd.shouldSucceed(`mv ${STAGING} /home/bo/staging`);
      assertEquals(await unlistedRoots(vfs), ['/home/bo/staging']);
      const feed = names(await client.execJson<Results>('search --sort -time -l 100'));
      assertEquals([feed.includes('portrait.jpg'), feed.includes('boat.jpg'), feed.includes('scan.jpg')], [true, false, false]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
