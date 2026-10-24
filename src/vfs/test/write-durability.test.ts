/**
 * The VFS tells a transaction what it writes, so a store can commit session
 * and tty state without waiting for its log to reach disk. What is pinned here
 * is the declaration itself: every create, update and unlink names its node's
 * durability, ephemeral only for the types in `EPHEMERAL_NODE_TYPES`, and a
 * transaction that writes both kinds hears both. What a store makes of it is
 * the store's own test.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { Transaction, WriteDurability } from '../mod.ts';
import { NODE_TYPE_SESSION } from '../types/session.ts';
import { NODE_TYPE_TTY } from '../types/tty.ts';
import { mkdir } from './helpers.ts';

Deno.test('VFS write durability', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  // Every transaction the VFS opens from here on records its declarations,
  // one list per transaction, in the order they were opened.
  const transactions: WriteDurability[][] = [];
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = async (): Promise<Transaction> => {
    const inner = await begin();
    const declared: WriteDurability[] = [];
    transactions.push(declared);
    return {
      get id() {
        return inner.id;
      },
      get active() {
        return inner.active;
      },
      commit: () => inner.commit(),
      rollback: () => inner.rollback(),
      declareWrite: (durability) => declared.push(durability),
    };
  };
  const last = () => transactions[transactions.length - 1];

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'sessions');

    await t.step('a directory is a durable write', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'etc');
      assertEquals(last(), ['durable']);
    });

    await t.step('a session and a tty are ephemeral writes, created and updated', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_SESSION, '/sessions', 's1', { attrs: { name: 's1' } });
      assertEquals(last(), ['ephemeral']);

      await vfs.create(ADMIN_ACCESS, NODE_TYPE_TTY, '/sessions/s1', 'tty-1', { attrs: { name: 'tty-1' } });
      assertEquals(last(), ['ephemeral']);

      await vfs.update(ADMIN_ACCESS, '/sessions/s1/tty-1', { attrs: { cwd: '/etc' } });
      assertEquals(last(), ['ephemeral']);
    });

    await t.step('unlinking them is ephemeral too, one declaration per node', async () => {
      await vfs.unlink(ADMIN_ACCESS, '/sessions/s1/tty-1', '/sessions/s1');
      assertEquals(last(), ['ephemeral']);

      await vfs.create(ADMIN_ACCESS, NODE_TYPE_TTY, '/sessions/s1', 'tty-2', { attrs: { name: 'tty-2' } });
      await vfs.unlink(ADMIN_ACCESS, '/sessions/s1', '/sessions', { recursive: true });
      // The recursive pass batches the tty, then the session's own edge goes.
      const recent = transactions.slice(-2);
      assertEquals(recent, [['ephemeral'], ['ephemeral']]);
    });

    await t.step('a subtree mixing both kinds declares both, so the commit stays durable', async () => {
      await vfs.createTree(ADMIN_ACCESS, '/sessions', [{
        type: NODE_TYPE_SESSION,
        name: 's2',
        attrs: { name: 's2' },
        children: [{ type: 'directory', name: 'scratch', attrs: { name: 'scratch' } }],
      }]);
      assertEquals(last(), ['ephemeral', 'durable']);
    });
  } finally {
    await ctx.dispose();
  }
});
