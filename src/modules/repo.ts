/**
 * Where the modules' source, and core's own files, sit in this checkout.
 *
 * A checkout's `modules/` holds the module checkouts it is developed and run with, each a repository
 * of its own; core names none of them, and may have none. Core's files that boot mounts at `/usr/lib` — its bash commands and services, the browser
 * shell — are under `src/builtin`. Tests, scripts and the harness read the checkout through here,
 * so neither location is spelled out anywhere else.
 */

import { join } from '@std/path';

export const REPO_ROOT = join(import.meta.dirname!, '..', '..');

/** What boot mounts read-only at `LIB_PATH`: `src/builtin`. */
export const LIB_SOURCE_DIR = join(REPO_ROOT, 'src', 'builtin');

/** The browser shell's source: `src/builtin/ui`. */
export const UI_SOURCE_DIR = join(LIB_SOURCE_DIR, 'ui');

/** The modules' parent: `modules`. */
export const MODULES_DIR = join(REPO_ROOT, 'modules');

/** A module's directory in the checkout; it need not exist. */
export const moduleSourceDir = (name: string): string => join(MODULES_DIR, name);

/** Every module in the checkout, as name and directory, by name; none when there is no `modules/`. */
export const repoModules = (): { name: string; dir: string }[] => {
  const out: { name: string; dir: string }[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(MODULES_DIR)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory || entry.isSymlink) out.push({ name: entry.name, dir: join(MODULES_DIR, entry.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};
