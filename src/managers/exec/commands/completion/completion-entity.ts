/**
 * completion-entity — name completion over the things media hangs off.
 *
 * What backs the `@`-mention popup in the search box. It answers the one
 * question a completion asks — "which people, locations, albums or devices are
 * called something like this?" — and deliberately answers *only* that. The kinds
 * are the installed modules' node types that have a root.
 *
 * `search` is the wrong tool for a keystroke: it fans out to every provider,
 * each in its own subshell, and several embed the query with a model. A
 * completion needs names, not semantics, so this is one command, no subshells,
 * no embeddings, one listing per kind run in parallel and cached for a few
 * seconds.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { completions } from '../../../../lib/contributions/registry.ts';
import type { NodeType } from '../../../../vfs/mod.ts';
import { nodeOwnership } from '../../../../lib/access/verify-access.ts';
import type { EntityCompleteHit, EntityCompleteResult, NodeOwnership } from '../../../../lib/api/mod.ts';

/**
 * The kinds an `@` can resolve to, and where each lives: the installed modules' node types that
 * have a `root` (`mod.json` `nodeTypes`), read at each call so a module set up later is completable at once.
 */
type EntityKind = string;
const entities = (): Record<EntityKind, { type: NodeType; root: string }> => completions();
const isKind = (value: string): value is EntityKind => value in entities();

/**
 * How long a kind's name list is reused before it is listed again.
 *
 * A completion runs per keystroke, so the first one pays for the listing and the
 * rest of the word is free. Module scope, so it survives between command
 * invocations in one instance.
 *
 * The TTL alone is not enough. Someone can create a person from the header menu
 * and immediately want to `@`-mention them, and a cache that shrugged for the
 * next half minute would look broken — so the count of the root is checked
 * first, which catches every creation and deletion. A *rename* or a change of
 * owner or mode changes no count, and that is what the TTL is left to bound.
 */
const CACHE_TTL_MS = 30_000;

const DEFAULT_LIMIT = 8;

/** One entity's searchable identity: what it is called, how it is stored, where it lives and who may change it. */
type Entry = { name: string; names: string[]; path: string; ownership: NodeOwnership };

const cache = new Map<EntityKind, { at: number; count: number; entries: Entry[] }>();

/** What separates the words of a name, and of a query. */
const WORD_BREAK = /[\s\-_]+/;

/**
 * Where an in-order match of every query word as the start of a name word begins, words of the
 * name skipped between them: the index of the name word the first query word starts, or -1 when
 * the words do not all match. Taking each query word's earliest match is enough: a later one
 * leaves fewer name words for the rest.
 */
const wordsMatchAt = (queryWords: string[], words: string[]): number => {
  let first = -1;
  let at = 0;
  for (const queryWord of queryWords) {
    while (at < words.length && !words[at].startsWith(queryWord)) at++;
    if (at === words.length) return -1;
    if (first < 0) first = at;
    at++;
  }
  return first;
};

/**
 * Exact, then prefix, then word-prefix, then substring.
 *
 * A word prefix sits between the other two on purpose: typing `strand` should
 * offer "Anna Strand-Berg" ahead of someone whose name merely contains
 * the letters, because it is how people search for a surname.
 *
 * Several words count as one prefix when each starts a word of the name, in
 * order, words skipped between them: `anna strand` is a prefix of "Anna K
 * Strand-Berg", the way people write a name without its middle one, and
 * `k strand` a word prefix of it.
 *
 * The VFS child name and `attrs.name` are both searched. The latter is the
 * label shown in the UI, while the former remains a useful way to find an
 * entity whose human-friendly name was changed after it was created.
 */
const score = (query: string, label: string): number => {
  const value = label.toLowerCase();
  if (value === query) return 1;
  if (value.startsWith(query)) return 0.9;
  const words = value.split(WORD_BREAK);
  const queryWords = query.split(WORD_BREAK).filter(Boolean);
  const matchAt = queryWords.length > 1 ? wordsMatchAt(queryWords, words) : -1;
  if (matchAt === 0) return 0.9;
  if (matchAt > 0 || words.some((word) => word.startsWith(query))) return 0.7;
  if (value.includes(query)) return 0.4;

  // A compact ordered-character match catches the small omissions people make
  // while typing without turning a one-letter query into every entity. It is a
  // fallback behind the explainable exact/prefix matches above.
  if (query.length < 2) return 0;
  let cursor = 0;
  let first = -1;
  for (const char of query) {
    const index = value.indexOf(char, cursor);
    if (index < 0) return 0;
    if (first < 0) first = index;
    cursor = index + 1;
  }
  const span = cursor - first;
  return 0.15 + 0.2 * (query.length / span);
};

/**
 * Every entity of one kind, by name.
 *
 * One listing of the root, not a query by node type: the root has exactly the
 * catalogued things in it and its children carry their own names, so nothing
 * needs resolving, where a type query pays a path resolution per row.
 */
const listKind = async (cmd: Command, kind: EntityKind): Promise<Entry[]> => {
  const { type, root } = entities()[kind];

  // Counting is a COUNT query; listing materializes every child. Asking the
  // cheap question first is what lets the expensive answer be reused.
  let count: number;
  try {
    count = await cmd.sys.vfs.childCount(cmd.access, root);
  } catch {
    // Root missing on this instance; an empty list, not an error.
    return [];
  }

  const cached = cache.get(kind);
  if (cached && cached.count === count && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;

  const entries: Entry[] = [];
  try {
    for (const child of await cmd.sys.vfs.children(cmd.access, root)) {
      if (child.node.type !== type) continue;
      const attrs = child.node.attrs as { name?: string };
      const name = attrs.name?.trim() || child.name;
      // Avoid giving a name that is both the stored and displayed identity two
      // chances to affect ranking.
      entries.push({ name, names: [...new Set([name, child.name])], path: `${root}/${child.name}`, ownership: nodeOwnership(child.node) });
    }
  } catch {
    return [];
  }

  cache.set(kind, { at: Date.now(), count, entries });
  return entries;
};

const completeKind = async (cmd: Command, kind: EntityKind, query: string, limit: number): Promise<EntityCompleteHit[]> => {
  const hits: EntityCompleteHit[] = [];

  for (const entry of await listKind(cmd, kind)) {
    const value = Math.max(...entry.names.map((name) => score(query, name)));
    if (value > 0) hits.push({ kind, type: entities()[kind].type, name: entry.name, path: entry.path, score: value, ownership: entry.ownership });
  }

  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
};

export const completeEntity = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['kind', 'limit'], alias: { l: 'limit' } });

  const query = flags._.join(' ').trim().toLowerCase();
  if (!query) {
    await cmd.writeJSON({ results: [] } satisfies EntityCompleteResult);
    return 0;
  }

  const limit = Math.max(parseInt(flags.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1);

  const wanted: EntityKind[] = [];
  for (const raw of (flags.kind ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!isKind(value)) {
      await cmd.writeError(`completion-entity: unknown kind '${value}' (expected: ${Object.keys(entities()).join(', ')})\n`);
      return 1;
    }
    wanted.push(value);
  }
  if (wanted.length === 0) wanted.push(...Object.keys(entities()));

  // In parallel: each kind is an independent indexed query, and a completion is
  // waiting on the slowest one rather than on their sum.
  const perKind = await Promise.all(wanted.map((kind) => completeKind(cmd, kind, query, limit)));

  // Round-robin across kinds, best of each first. A flat sort by score lets a
  // kind with thousands of entries fill every slot; taking one from each kind
  // per pass keeps every kind reachable while still leading with the best match.
  const queues = perKind.map((hits) => [...hits].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)));
  const results: EntityCompleteHit[] = [];
  while (results.length < limit && queues.some((queue) => queue.length > 0)) {
    // Whichever kind's *next* hit is strongest goes next, so a weak match in one
    // kind never outranks a strong one in another.
    let best = -1;
    for (const [index, queue] of queues.entries()) {
      if (queue.length === 0) continue;
      if (best < 0 || queue[0].score > queues[best][0].score) best = index;
    }
    if (best < 0) break;
    results.push(queues[best].shift()!);
    // Move that kind to the back of the queue order so the next pass prefers the
    // others at equal score.
    queues.push(queues.splice(best, 1)[0]);
  }

  if (cmd.json) {
    await cmd.writeJSON({ results } satisfies EntityCompleteResult);
    return 0;
  }

  for (const hit of results) {
    await cmd.writeLn(`${(hit.score * 100).toFixed(0).padStart(3)}%  ${hit.kind.padEnd(7)}  ${hit.name}  (${hit.path})`);
  }
  return 0;
};

completeEntity.spec = {
  name: 'completion-entity',
  effect: 'read' as const,
  description: 'Complete a person, location, album or device by name',
  args: [
    { name: 'query', type: 'string' as const, description: 'the partial name typed so far' },
  ],
  flags: [
    {
      name: 'kind',
      type: 'string' as const,
      description: 'restrict to these kinds, comma-separated: whichever the installed modules declare (person, location, album, device)',
    },
    { name: 'limit', type: 'string' as const, description: `maximum suggestions (default ${DEFAULT_LIMIT})` },
  ],
};
