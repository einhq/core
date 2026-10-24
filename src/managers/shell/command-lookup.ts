/**
 * Finding an external command on `$PATH`: module bins, since core commands resolve before this.
 *
 * Each `PATH` entry costs one `exists(join(dir, name))`; a `PATH` entry that does not exist
 * falls through, since `exists` swallows `NodeNotFoundError`. The answer changes only when a
 * module is installed or removed, so it is cached, negative answers included: a miss on an early
 * `PATH` entry is most of the work when the bin lives in a late one.
 *
 * The cache is TTL-bounded rather than invalidated from VFS events on purpose. `/modules/<name>`
 * are softlinks into a filesystem-store mount of the host's `modules/` directory, so a bin added
 * or removed on the host produces no VFS event to subscribe to. A short TTL bounds that staleness.
 * `clearCommandLookupCache()` makes an install visible at once.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import type { NodePath, NodeVFS } from '../../vfs/mod.ts';

/** How long a resolution stays good. Short enough that a stale answer self-heals unnoticed. */
const DEFAULT_TTL_MS = 5000;

const ttlMs = (): number => {
  const raw = Number(Deno.env.get('COMMAND_LOOKUP_TTL_MS'));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

type Entry = { path?: NodePath; at: number };

/**
 * Process-wide, not per shell: the pipeline runs each step in its own shell, so a per-shell cache
 * would miss on every step and this is exactly the caller that fans out over module commands.
 */
const cache = new Map<string, Entry>();

/** `PATH` is part of the key — two shells with different `PATH`s must not share an answer. */
const keyOf = (path: string, name: string): string => `${path}\0${name}`;

/** Drop every memoised resolution. Called when the set of installed commands changes. */
export const clearCommandLookupCache = (): void => {
  cache.clear();
  prefixCache.clear();
};

/**
 * Resolve `name` against `path` (a `$PATH` string), or `undefined` if no entry holds it.
 *
 * The lookup uses `ADMIN_ACCESS` because it answers "does this exist", not "may this caller run
 * it". The caller still asserts execute access on the node it
 * gets back.
 */
export const lookupCommandPath = async (
  vfs: NodeVFS,
  path: string,
  name: string,
): Promise<NodePath | undefined> => {
  const key = keyOf(path, name);
  const ttl = ttlMs();
  const cached = cache.get(key);

  if (cached && Date.now() - cached.at < ttl) {
    return cached.path;
  }

  let found: NodePath | undefined;

  for (const dir of new Set(path.split(':').filter(Boolean))) {
    const candidate = join(dir, name);

    if (await vfs.exists(ADMIN_ACCESS, candidate)) {
      found = candidate;
      break;
    }
  }

  cache.set(key, { path: found, at: Date.now() });

  return found;
};

/** `commandsNamed`' answers, by `PATH` and prefix; dropped with the lookups. */
const prefixCache = new Map<string, { names: string[]; at: number }>();

/**
 * Every command on `path` whose name starts with `prefix`, each name once (the first `PATH` entry
 * holding it wins, as when it runs), in name order. How core finds the commands that play a role
 * by their name — `search-*` for `search`'s text providers — rather than a list a module declares.
 * Memoised and dropped like `lookupCommandPath`'s answers.
 */
export const commandsNamed = async (vfs: NodeVFS, path: string, prefix: string): Promise<string[]> => {
  const key = keyOf(path, `${prefix}*`);
  const cached = prefixCache.get(key);
  if (cached && Date.now() - cached.at < ttlMs()) return cached.names;

  const names = new Set<string>();
  for (const dir of new Set(path.split(':').filter(Boolean))) {
    let entries;
    try {
      entries = await vfs.children(ADMIN_ACCESS, dir);
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.name.startsWith(prefix) && entry.name.length > prefix.length) names.add(entry.name);
  }

  const sorted = [...names].sort();
  prefixCache.set(key, { names: sorted, at: Date.now() });
  return sorted;
};
