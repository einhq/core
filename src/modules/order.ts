/**
 * Dependency ordering for `mod setup`.
 *
 * `ls` order is alphabetical, and a module can sort before what it depends on (`device` before
 * `people`), so a module is set up only after its dependencies: ordering is a precondition of
 * validation, not a nicety.
 */

import { join } from '@std/path';
import type { Access } from '../lib/access/mod.ts';
import type { NodeVFS } from '../vfs/mod.ts';
import type { ModuleManifest } from './types.ts';
import { readModJson } from './utils.ts';

export type SetupOrder = {
  /** Module names, dependencies before dependents. */
  order: string[];
  /** Cycles found, each as the path that closed it. Modules in a cycle are left out of `order`. */
  cycles: string[][];
};

/**
 * Topologically sort installed modules by their declared dependencies.
 *
 * Dependencies on modules that are not installed are ignored here — that is validation's job to
 * report, and refusing to order the rest would turn one missing module into a dead boot.
 */
export const resolveSetupOrder = (manifests: Map<string, ModuleManifest>): SetupOrder => {
  const order: string[] = [];
  const cycles: string[][] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  // Members of a cycle are never marked done, so every one of them is also a top-level entry
  // point that rediscovers the same loop. Key on the member set to report each cycle once.
  const seenCycles = new Set<string>();

  const visit = (name: string, path: string[]): void => {
    if (done.has(name)) return;
    if (onStack.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const key = [...new Set(cycle)].sort().join('\0');
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(cycle);
      }
      return;
    }
    onStack.add(name);

    for (const dep of Object.keys(manifests.get(name)?.dependencies ?? {}).sort()) {
      if (manifests.has(dep)) visit(dep, [...path, name]);
    }

    onStack.delete(name);
    // A module that closed a cycle must not be emitted as if it were ordered.
    if (!cycles.some((cycle) => cycle.includes(name))) {
      done.add(name);
      order.push(name);
    }
  };

  for (const name of [...manifests.keys()].sort()) visit(name, []);

  return { order, cycles };
};

/** Read every module manifest under `modulesPath`. */
export const readManifests = async (
  vfs: NodeVFS,
  access: Access,
  modulesPath: string,
): Promise<Map<string, ModuleManifest>> => {
  const manifests = new Map<string, ModuleManifest>();

  let children;
  try {
    children = await vfs.children(access, modulesPath);
  } catch {
    return manifests;
  }

  for (const child of children) {
    const manifest = await readModJson(vfs, access, join(modulesPath, child.name));
    if (manifest) manifests.set(child.name, manifest);
  }

  return manifests;
};
