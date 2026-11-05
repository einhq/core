/**
 * Which processing a folder wants: the nearest directory with a `processing` attr decides, a nested
 * one overriding its parent; no setting wants every family and an empty list none. The kept list
 * of those directories follows the attr being set, changed and cleared, and a directory moving or
 * going.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { familiesOf, PROCESSING_ATTR, processingAt, type ProcessingRoot, processingRoots, wantsProcessing } from '../processing.ts';

Deno.test('the nearest folder decides which families are wanted', () => {
  const roots: ProcessingRoot[] = [
    { path: '/archive/recipes/soups', families: ['renditions', 'picture-vectors'] },
    { path: '/archive/recipes', families: ['renditions'] },
    { path: '/home/anna/quiet', families: [] },
  ];
  assertEquals(processingAt(roots, '/archive/recipes/pancakes/pictures/a.jpg'), ['renditions']);
  assertEquals(processingAt(roots, '/archive/recipes/soups/b.jpg'), ['renditions', 'picture-vectors']);
  assertEquals(processingAt(roots, '/archive/recipes'), ['renditions']);
  assertEquals(processingAt(roots, '/archive/recipes-old/a.jpg'), undefined);
  assertEquals(processingAt(roots, '/archive/albums/a.jpg'), undefined);

  assertEquals(wantsProcessing(roots, '/archive/albums/a.jpg', ['archive']), true);
  assertEquals(wantsProcessing(roots, '/archive/recipes/pancakes/a.jpg', ['renditions']), true);
  assertEquals(wantsProcessing(roots, '/archive/recipes/pancakes/a.jpg', ['archive']), false);
  assertEquals(wantsProcessing(roots, '/archive/recipes/pancakes/a.jpg', ['archive', 'renditions']), true);
  assertEquals(wantsProcessing(roots, '/archive/recipes/soups/b.jpg', ['picture-vectors']), true);
  assertEquals(wantsProcessing(roots, '/home/anna/quiet/c.jpg', ['renditions']), false);
  assertEquals(wantsProcessing([{ path: '/', families: ['renditions'] }], '/archive/albums/a.jpg', ['archive']), false);
});

Deno.test('an attr value names its families', () => {
  assertEquals(familiesOf(['renditions', 'archive']), ['renditions', 'archive']);
  assertEquals(familiesOf('renditions'), ['renditions']);
  assertEquals(familiesOf([]), []);
  assertEquals(familiesOf(['renditions', 3, '']), ['renditions']);
  assertEquals(familiesOf(''), undefined);
  assertEquals(familiesOf(true), undefined);
  assertEquals(familiesOf(undefined), undefined);
});

Deno.test({
  name: 'the kept folders follow the attr and the directories',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs, dispose } = await createTestVfs();

  /** The kept list once it shows `expected`, or the last one read when it never does. */
  const settled = async (expected: ProcessingRoot[]): Promise<readonly ProcessingRoot[]> => {
    let roots = await processingRoots(vfs);
    for (let tries = 0; tries < 50 && JSON.stringify(roots) !== JSON.stringify(expected); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      roots = await processingRoots(vfs);
    }
    return roots;
  };

  try {
    for (const [parent, name] of [['/', 'archive'], ['/archive', 'recipes'], ['/archive/recipes', 'soups'], ['/archive', 'albums']]) {
      await vfs.create(ADMIN_ACCESS, 'directory', parent, name);
    }

    await t.step('no folder says anything at first', async () => {
      assertEquals(await settled([]), []);
    });

    await t.step('setting the attr adds the folder, the deepest first', async () => {
      await vfs.update(ADMIN_ACCESS, '/archive/recipes', { attrs: { [PROCESSING_ATTR]: ['renditions'] } });
      await vfs.update(ADMIN_ACCESS, '/archive/recipes/soups', { attrs: { [PROCESSING_ATTR]: 'picture-vectors' } });
      const expected = [
        { path: '/archive/recipes/soups', families: ['picture-vectors'] },
        { path: '/archive/recipes', families: ['renditions'] },
      ];
      assertEquals(await settled(expected), expected);
    });

    await t.step('changing and clearing it are followed', async () => {
      await vfs.update(ADMIN_ACCESS, '/archive/recipes', { attrs: { [PROCESSING_ATTR]: ['renditions', 'text'] } });
      await vfs.update(ADMIN_ACCESS, '/archive/recipes/soups', { attrs: { [PROCESSING_ATTR]: null } });
      const expected = [{ path: '/archive/recipes', families: ['renditions', 'text'] }];
      assertEquals(await settled(expected), expected);
    });

    await t.step('a folder moved takes its setting along, and one removed takes it away', async () => {
      await vfs.rename(ADMIN_ACCESS, '/archive', 'recipes', '/archive/albums', 'recipes');
      const moved = [{ path: '/archive/albums/recipes', families: ['renditions', 'text'] }];
      assertEquals(await settled(moved), moved);

      await vfs.unlink(ADMIN_ACCESS, '/archive/albums/recipes', '/archive/albums', { recursive: true });
      assertEquals(await settled([]), []);
    });
  } finally {
    await dispose();
  }
});
