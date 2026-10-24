/**
 * Attr update semantics: the update is a patch, so an omitted key is left untouched and a
 * null or undefined value removes the key, so a key can be deleted without writing a falsy value that
 * still reads back as present.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';

Deno.test('attrs update: null deletes, omitted keys survive', async (t) => {
  const { vfs } = await createTestVfs();

  await vfs.create(ADMIN_ACCESS, 'file', '/', 'note', {
    props: { mode: 0o644 },
    attrs: { name: 'note', keep: 'yes', drop: 'no', unnamed: true },
  });

  await t.step('omitting a key leaves it untouched', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { keep: 'still-yes' } });
    const attrs = (await vfs.get(ADMIN_ACCESS, '/note')).attrs;
    assertEquals(attrs.keep, 'still-yes');
    assertEquals(attrs.drop, 'no', 'unmentioned key must not be cleared');
  });

  await t.step('null removes the key rather than storing null', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { drop: null } });
    const attrs = (await vfs.get(ADMIN_ACCESS, '/note')).attrs;
    assertEquals(Object.hasOwn(attrs, 'drop'), false);
    assertEquals(attrs.keep, 'still-yes');
  });

  await t.step('a boolean flag can be removed, not just set false', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { unnamed: null } });
    const attrs = (await vfs.get(ADMIN_ACCESS, '/note')).attrs;
    assertEquals(Object.hasOwn(attrs, 'unnamed'), false, 'should be gone, not false');
  });

  await t.step('deleting an absent key is a no-op', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { neverThere: null } });
    assertEquals((await vfs.get(ADMIN_ACCESS, '/note')).attrs.keep, 'still-yes');
  });

  await t.step('undefined removes the key, as null does', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { gone: 1 } });
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { gone: undefined } });
    const attrs = (await vfs.get(ADMIN_ACCESS, '/note')).attrs;
    assertEquals(Object.hasOwn(attrs, 'gone'), false);
    assertEquals(attrs.keep, 'still-yes');
  });

  await t.step('set and delete in one update', async () => {
    await vfs.update(ADMIN_ACCESS, '/note', { attrs: { added: 1, keep: null } });
    const attrs = (await vfs.get(ADMIN_ACCESS, '/note')).attrs;
    assertEquals(attrs.added, 1);
    assertEquals(Object.hasOwn(attrs, 'keep'), false);
  });
});
