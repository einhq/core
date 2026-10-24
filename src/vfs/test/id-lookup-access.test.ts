/**
 * Lookups that find a node without walking a path — by id, by attr query, from a
 * registry — meet the rule a path walk does: execute on every ancestor.
 *
 * The case pinned here: a staging directory is 0700 while the files in it keep
 * the default 0775, so a check of the node's own mode alone would hand one
 * person's uploads to everyone.
 */

import { assertEquals } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeId } from '../mod.ts';
import { mkdir, mkfile } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 5000, gids: [5000, 4000] };
const OTHER: Access = { uid: 6000, gid: 6000, gids: [6000, 4000] };

const enc = new TextEncoder();

Deno.test('VFS id lookups check every ancestor', async (t) => {
  const ctx = await createTestVfs();
  const mounted = await createTestVfs();
  const { vfs } = ctx;

  try {
    // /home/owner/staging (0700) holding a 0775 photo with a position child, next to
    // /shared (0755) holding a 0775 photo. Both photos carry the same attr.
    await mkdir(vfs, ADMIN_ACCESS, '/', 'home', 0o755);
    await mkdir(vfs, ADMIN_ACCESS, '/home', 'owner', 0o755);
    await vfs.update(ADMIN_ACCESS, '/home/owner', { props: { uid: OWNER.uid, gid: OWNER.gid } });
    await mkdir(vfs, OWNER, '/home/owner', 'staging', 0o700);
    await mkdir(vfs, ADMIN_ACCESS, '/', 'shared', 0o755);

    const staged = await vfs.create(OWNER, 'file', '/home/owner/staging', 'staged.jpg', {
      props: { mode: 0o775 },
      attrs: { name: 'staged.jpg', label: 'photo' },
    });
    const open = await vfs.create(ADMIN_ACCESS, 'file', '/shared', 'open.jpg', {
      props: { mode: 0o775 },
      attrs: { name: 'open.jpg', label: 'photo' },
    });

    const writePoint = async (access: Access, path: string, lat: number, lng: number) => {
      const handle = await vfs.open(access, path, { mode: 'w' });
      await handle.write(enc.encode(JSON.stringify({ lat, lng })));
      await handle.close();
    };
    const stagedPosition = await vfs.create(OWNER, 'position', '/home/owner/staging/staged.jpg', 'position', { props: { mode: 0o775 } });
    await writePoint(OWNER, '/home/owner/staging/staged.jpg/position', 57.70, 11.90);
    const openPosition = await vfs.create(ADMIN_ACCESS, 'position', '/shared/open.jpg', 'position', { props: { mode: 0o775 } });
    await writePoint(ADMIN_ACCESS, '/shared/open.jpg/position', 57.71, 11.91);

    const photos = async (access: Access) =>
      (await vfs.query(access, { types: ['file'], where: [{ ref: 'label', op: 'eq', value: 'photo' }], limit: 10 }))
        .map((entry) => entry.absPath).sort();

    await t.step('query: the owner sees staging, nobody else does', async () => {
      assertEquals(await photos(OWNER), ['/home/owner/staging/staged.jpg', '/shared/open.jpg']);
      assertEquals(await photos(OTHER), ['/shared/open.jpg']);
      assertEquals((await photos(ADMIN_ACCESS)).length, 2);
    });

    await t.step('aggregate counts what query returns', async () => {
      const count = async (access: Access, types: string[]) => (await vfs.aggregate(access, { types, group: [{ column: 'type' }] })).map((bucket) => bucket.count)[0] ?? 0;
      assertEquals(await count(OWNER, ['file']), 2);
      assertEquals(await count(OTHER, ['file']), 1);
      assertEquals(await count(ADMIN_ACCESS, ['file']), 2);
      // A child of a file is reached through the file's parent.
      assertEquals(await count(OWNER, ['position']), 2);
      assertEquals(await count(OTHER, ['position']), 1);

      const within = await vfs.aggregate(OTHER, { within: '/shared', types: ['file'], group: [{ column: 'type' }] });
      assertEquals(within.map((bucket) => bucket.count), [1]);
    });

    await t.step('resolveId and resolveIdEntries return only walkable paths', async () => {
      assertEquals((await vfs.resolveId(OWNER, staged.id)).map((e) => e.absPath), ['/home/owner/staging/staged.jpg']);
      assertEquals(await vfs.resolveId(OTHER, staged.id), []);

      const entries = await vfs.resolveIdEntries(OTHER, [staged.id, open.id]);
      assertEquals([...entries.keys()], [open.id]);
      assertEquals((await vfs.resolveIdPaths(OWNER, [staged.id])).get(staged.id), ['/home/owner/staging/staged.jpg']);
    });

    await t.step('getNodesByIds drops nodes behind a closed directory', async () => {
      assertEquals([...(await vfs.getNodesByIds(OWNER, [staged.id, open.id])).keys()].sort(), [staged.id, open.id].sort());
      assertEquals([...(await vfs.getNodesByIds(OTHER, [staged.id, open.id])).keys()], [open.id]);
    });

    await t.step('getParentLinksByIds and getChildLinksByIds do too', async () => {
      assertEquals([...(await vfs.getParentLinksByIds(OTHER, [staged.id, open.id])).keys()], [open.id]);
      assertEquals((await vfs.getParentLinksByIds(OWNER, [staged.id])).get(staged.id)?.map((link) => link.name), ['staged.jpg']);

      assertEquals([...(await vfs.getChildLinksByIds(OTHER, [staged.id, open.id])).keys()], [open.id]);
      assertEquals((await vfs.getChildLinksByIds(OWNER, [staged.id])).get(staged.id)?.length, 1);
    });

    await t.step('registry searches filter their hits', async () => {
      const bounds = { north: 58, south: 57, east: 12, west: 11 };
      const ids = (matches: { id: string }[]) => matches.map((match) => match.id as NodeId).sort();

      assertEquals(ids(await vfs.findWithin(OWNER, bounds)), [stagedPosition.id, openPosition.id].sort());
      assertEquals(ids(await vfs.findWithin(OTHER, bounds)), [openPosition.id]);
      assertEquals(ids(await vfs.findNearby(OTHER, 57.70, 11.90, 50_000)), [openPosition.id]);
    });

    await t.step('getPoints answers only the positions the caller can reach', async () => {
      const both = [stagedPosition.id, openPosition.id];
      assertEquals([...(await vfs.getPoints(OWNER, both)).keys()].sort(), [...both].sort());
      assertEquals([...(await vfs.getPoints(OTHER, both)).keys()], [openPosition.id]);
      assertEquals((await vfs.getPoints(ADMIN_ACCESS, [stagedPosition.id])).get(stagedPosition.id), { lat: 57.70, lng: 11.90 });
    });

    await t.step('trackSummaries answers only the tracks the caller can reach', async () => {
      const stagedTrack = await vfs.create(OWNER, 'track', '/home/owner/staging', 'track', { props: { mode: 0o775 } });
      const openTrack = await vfs.create(ADMIN_ACCESS, 'track', '/shared', 'track', { props: { mode: 0o775 } });
      const handle = await vfs.open(OWNER, '/home/owner/staging/track', { mode: 'a' });
      await handle.write(enc.encode(JSON.stringify({ lat: 57.70, lng: 11.90, ts: '2020-05-01T10:00:00.000Z' }) + '\n'));
      await handle.close();

      const both = [stagedTrack.id, openTrack.id, staged.id];
      assertEquals([...(await vfs.trackSummaries(OWNER, both)).keys()].sort(), [stagedTrack.id, openTrack.id].sort());
      assertEquals([...(await vfs.trackSummaries(OTHER, both)).keys()], [openTrack.id]);
      assertEquals((await vfs.trackSummaries(ADMIN_ACCESS, [stagedTrack.id])).get(stagedTrack.id)?.points, 1);
    });

    await t.step('a hard link elsewhere makes the node reachable through that path only', async () => {
      await vfs.link(ADMIN_ACCESS, '/home/owner/staging/staged.jpg', '/shared', 'promoted.jpg');

      assertEquals((await vfs.resolveId(OTHER, staged.id)).map((e) => e.absPath), ['/shared/promoted.jpg']);
      assertEquals([...(await vfs.getNodesByIds(OTHER, [staged.id])).keys()], [staged.id]);
      assertEquals(await photos(OTHER), ['/shared/open.jpg', '/shared/promoted.jpg']);

      await vfs.unlink(ADMIN_ACCESS, '/shared/promoted.jpg', '/shared');
      assertEquals(await photos(OTHER), ['/shared/open.jpg']);
    });

    await t.step('a link in a trash the caller can pass does not open its other path', async () => {
      await mkdir(vfs, OWNER, '/home/owner', '.trash', 0o755);
      await vfs.link(ADMIN_ACCESS, '/home/owner/staging/staged.jpg', '/home/owner/.trash', 'staged.jpg');

      assertEquals(await photos(OTHER), ['/shared/open.jpg']);
      assertEquals(await vfs.resolveId(OTHER, staged.id), []);
      assertEquals(await photos(OWNER), ['/home/owner/staging/staged.jpg', '/shared/open.jpg']);

      await vfs.unlink(ADMIN_ACCESS, '/home/owner/.trash/staged.jpg', '/home/owner/.trash');
    });

    await t.step('a mount under a closed directory hides what it holds', async () => {
      await mkfile(mounted.vfs, ADMIN_ACCESS, '/', 'inside.txt', 'x', 0o755);
      await mkdir(vfs, OWNER, '/home/owner/staging', 'disk', 0o755);
      await vfs.mount(ADMIN_ACCESS, '/home/owner/staging/disk', mounted.vfs);
      const inside = await mounted.vfs.get(ADMIN_ACCESS, '/inside.txt');

      assertEquals((await vfs.resolveId(OWNER, inside.id)).map((e) => e.absPath), ['/home/owner/staging/disk/inside.txt']);
      assertEquals(await vfs.resolveId(OTHER, inside.id), []);
      assertEquals([...(await vfs.getNodesByIds(OTHER, [inside.id])).keys()], []);
      const files = async (access: Access) => (await vfs.query(access, { types: ['file'], limit: 10 })).map((e) => e.absPath);
      assertEquals((await files(OWNER)).includes('/home/owner/staging/disk/inside.txt'), true);
      assertEquals((await files(OTHER)).includes('/home/owner/staging/disk/inside.txt'), false);

      const mountedPosition = await mounted.vfs.create(ADMIN_ACCESS, 'position', '/inside.txt', 'position', { props: { mode: 0o775 } });
      const handle = await mounted.vfs.open(ADMIN_ACCESS, '/inside.txt/position', { mode: 'w' });
      await handle.write(enc.encode(JSON.stringify({ lat: 57.72, lng: 11.92 })));
      await handle.close();
      assertEquals((await vfs.getPoints(OWNER, [mountedPosition.id])).get(mountedPosition.id), { lat: 57.72, lng: 11.92 });
      assertEquals((await vfs.getPoints(OTHER, [mountedPosition.id])).size, 0);

      await vfs.unmount(ADMIN_ACCESS, '/home/owner/staging/disk');
    });

    await t.step('events under a closed directory reach only those who can walk there', async () => {
      const seen = { owner: [] as string[], other: [] as string[] };
      const subs = [
        await vfs.subscribe!(() => OWNER, (event) => void seen.owner.push(`${event.type} ${event.path}`)),
        await vfs.subscribe!(() => OTHER, (event) => void seen.other.push(`${event.type} ${event.path}`)),
      ];
      try {
        await vfs.create(OWNER, 'file', '/home/owner/staging', 'new.jpg', { props: { mode: 0o775 } });
        await vfs.create(ADMIN_ACCESS, 'file', '/shared', 'new.jpg', { props: { mode: 0o775 } });
        await vfs.unlink(OWNER, '/home/owner/staging/new.jpg', '/home/owner/staging');

        const deadline = Date.now() + 2000;
        while (!seen.other.includes('created /shared/new.jpg') || !seen.owner.includes('deleted /home/owner/staging/new.jpg')) {
          if (Date.now() > deadline) throw new Error('timed out waiting for events');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assertEquals(seen.owner.includes('created /home/owner/staging/new.jpg'), true);
        assertEquals(seen.other.filter((event) => event.includes('/home/owner/staging/')), []);
      } finally {
        for (const sub of subs) await sub.unsubscribe();
      }
    });

    await t.step('opening the directory opens everything under it', async () => {
      await vfs.update(OWNER, '/home/owner/staging', { props: { mode: 0o755 } });
      assertEquals(await photos(OTHER), ['/home/owner/staging/staged.jpg', '/shared/open.jpg']);
      assertEquals([...(await vfs.getNodesByIds(OTHER, [staged.id])).keys()], [staged.id]);
    });
  } finally {
    await mounted.dispose();
    await ctx.dispose();
  }
});
