/**
 * Who may read a queue: a read takes the entry from the queue's other consumers, so an open to
 * read needs write access as an append does, while a peek needs only read access and takes nothing.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError } from '../mod.ts';
import { NODE_TYPE_QUEUE } from '../types/queue.ts';
import { mkdir } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };
const GROUP_MATE: Access = { uid: 5001, gid: 4000, gids: [4000] };
const OTHER: Access = { uid: 6000, gid: 6000, gids: [6000] };
/** A share link that shows things as OWNER's group mate: their groups, and never a write. */
const LINK: Access = { uid: GROUP_MATE.uid, gid: GROUP_MATE.gid, gids: GROUP_MATE.gids, link: { id: 'k1' } };

const enc = new TextEncoder();
const dec = new TextDecoder();

Deno.test('a queue is read only by those who may write it', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'area', 0o777);
    await vfs.create(OWNER, NODE_TYPE_QUEUE, '/area', 'q', { props: { mode: 0o755 } });
    const append = await vfs.open(OWNER, '/area/q', { mode: 'a' });
    await append.write(enc.encode('{"job":1}\n{"job":2}\n'));
    await append.close();

    const waiting = async () => (await vfs.queuePeek(OWNER, '/area/q', 10)).map((entry) => entry.data);

    await t.step('a reader without write access is refused, and the entries stay', async () => {
      for (const access of [GROUP_MATE, OTHER, LINK]) {
        await assertRejects(() => vfs.open(access, '/area/q', { mode: 'r' }), NodeAccessDeniedError);
      }
      assertEquals(await waiting(), [{ job: 1 }, { job: 2 }]);
    });

    await t.step('a peek needs only read access and takes nothing', async () => {
      for (const access of [GROUP_MATE, OTHER]) {
        assertEquals((await vfs.queuePeek(access, '/area/q', 10)).map((entry) => entry.data), [{ job: 1 }, { job: 2 }]);
      }
      assertEquals(await waiting(), [{ job: 1 }, { job: 2 }]);
    });

    await t.step('one who may write it reads, and the entry is taken', async () => {
      const reader = await vfs.open(OWNER, '/area/q', { mode: 'r' });
      try {
        assertEquals(JSON.parse(dec.decode(await reader.read(0))), { job: 1 });
      } finally {
        await reader.close();
      }
      assertEquals(await waiting(), [{ job: 2 }]);
    });

    await t.step('a group granted write reads too', async () => {
      await vfs.update(OWNER, '/area/q', { props: { mode: 0o775, gid: OWNER.gid } });
      const reader = await vfs.open(GROUP_MATE, '/area/q', { mode: 'r' });
      try {
        assertEquals(JSON.parse(dec.decode(await reader.read(0))), { job: 2 });
      } finally {
        await reader.close();
      }
      assertEquals(await waiting(), []);
      // A share link writes nothing, whatever its groups may.
      await assertRejects(() => vfs.open(LINK, '/area/q', { mode: 'r' }), NodeAccessDeniedError);
    });
  } finally {
    await ctx.dispose();
  }
});
