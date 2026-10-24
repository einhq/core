/**
 * Every archive root has one owner. A module creates the roots it declares (`roots` in
 * `mod.json`, at `mod setup`); one two modules declare has no owner. Core's own, the label tree,
 * is made at boot, so no module declares it.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { TAGS_ROOT } from '../../lib/paths.ts';
import { repoModules } from '../repo.ts';
import type { ModuleManifest } from '../types.ts';

Deno.test("no archive root is declared by two modules, nor core's label tree by any", async () => {
  const owners = new Map<string, string[]>();
  for (const { name, dir } of repoModules()) {
    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(await Deno.readTextFile(join(dir, 'mod.json')));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const root of manifest.roots ?? []) owners.set(root, [...owners.get(root) ?? [], name]);
  }
  assertEquals([...owners].filter(([, names]) => names.length > 1), []);
  assert(!owners.has(TAGS_ROOT), `${TAGS_ROOT} is core's, but ${owners.get(TAGS_ROOT)?.join(', ')} declares it`);
});
