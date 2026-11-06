/**
 * TreeCache on its own: a kept walk comes back for its roots in any order, a drop of a node it
 * holds forgets it, and a walk read before such a drop is not kept after it.
 */

import { assertEquals } from '@std/assert';
import type { NodeId } from '../../../vfs/mod.ts';
import { TreeCache } from '../tree-cache.ts';

const ROOT = 'root' as NodeId;
const OTHER = 'other' as NodeId;
const DIR = 'dir' as NodeId;
const ELSEWHERE = 'elsewhere' as NodeId;

Deno.test('TreeCache keeps a walk until a node it holds is dropped', async (t) => {
  await t.step('a filled walk comes back for the same roots in any order', () => {
    const cache = new TreeCache();
    assertEquals(cache.get([ROOT]), undefined);
    cache.fill(cache.version, [ROOT, OTHER], [ROOT, OTHER, DIR]);
    assertEquals(cache.get([OTHER, ROOT]), [ROOT, OTHER, DIR]);
    assertEquals(cache.get([ROOT]), undefined);
  });

  await t.step('a drop of a node the walk holds forgets it; one elsewhere does not', () => {
    const cache = new TreeCache();
    cache.fill(cache.version, [ROOT], [ROOT, DIR]);
    cache.drop(ELSEWHERE);
    assertEquals(cache.get([ROOT]), [ROOT, DIR]);
    cache.drop(DIR);
    assertEquals(cache.get([ROOT]), undefined);
  });

  await t.step('a walk read before a drop of a node it holds is not kept', () => {
    const cache = new TreeCache();
    const version = cache.version;
    cache.drop(DIR);
    cache.fill(version, [ROOT], [ROOT, DIR]);
    assertEquals(cache.get([ROOT]), undefined);
    const later = cache.version;
    cache.drop(ELSEWHERE);
    cache.fill(later, [ROOT], [ROOT, DIR]);
    assertEquals(cache.get([ROOT]), [ROOT, DIR]);
  });

  await t.step('a walk read before the oldest drop remembered is not kept', () => {
    const cache = new TreeCache(16, 2);
    const version = cache.version;
    for (const id of ['a', 'b', 'c'] as NodeId[]) cache.drop(id);
    cache.fill(version, [ROOT], [ROOT]);
    assertEquals(cache.get([ROOT]), undefined);
  });

  await t.step('past its capacity the least recently used walk goes first', () => {
    const cache = new TreeCache(2);
    cache.fill(cache.version, [ROOT], [ROOT]);
    cache.fill(cache.version, [OTHER], [OTHER]);
    cache.get([ROOT]);
    cache.fill(cache.version, [DIR], [DIR]);
    assertEquals(cache.get([OTHER]), undefined);
    assertEquals(cache.get([ROOT]), [ROOT]);
  });
});
