/**
 * Expand a test's `modules:` selection to include transitive dependencies, in setup order.
 *
 * Reads mod.json straight off the host filesystem: this runs before boot, so there is no VFS to
 * read manifests through yet, and the repo checkout is where the modules live either way.
 */

import { join } from '@std/path';
import { moduleSourceDir } from '../modules/repo.ts';
import type { ModuleManifest } from '../modules/types.ts';

const readManifest = (name: string): ModuleManifest | undefined => {
  try {
    return JSON.parse(Deno.readTextFileSync(join(moduleSourceDir(name), 'mod.json'))) as ModuleManifest;
  } catch {
    return undefined;
  }
};

/**
 * Depth-first expansion, dependencies before dependents.
 *
 * A dependency naming a module that is not in the repo is skipped rather than thrown on — the
 * manifest is then wrong, which is `mod setup`'s job to report with a useful message, not the
 * harness's job to fail obscurely inside a constructor.
 */
export const expandModuleDeps = (requested: string[]): string[] => {
  const order: string[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();

  const visit = (name: string): void => {
    if (done.has(name) || onStack.has(name)) return;
    onStack.add(name);

    const manifest = readManifest(name);
    for (const dep of Object.keys(manifest?.dependencies ?? {}).sort()) {
      if (readManifest(dep)) visit(dep);
    }

    onStack.delete(name);
    done.add(name);
    order.push(name);
  };

  for (const name of requested) visit(name);

  return order;
};
