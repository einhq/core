/** Trashed nodes have no path to id lookups; see `trash-cases.ts`. The memory store. */

import { createTestVfs } from '../../testing/test-vfs.ts';
import { trashCases } from './trash-cases.ts';

Deno.test('VFS leaves trashed nodes out of id lookups', async (t) => {
  const ctx = await createTestVfs();
  try {
    await trashCases(ctx.vfs, (name, fn) => t.step(name, fn));
  } finally {
    await ctx.dispose();
  }
});
