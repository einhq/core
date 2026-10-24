/**
 * Subject facets for `search`: the media a subject node has — a person in the pictures, the location
 * they were taken, the camera that took them.
 *
 * Core knows no kind of subject. A module that has one puts `subject-<kind>` on `PATH` (see
 * `SubjectListing`), and this asks it: per ref, either the ids of the subject's media, or one attr
 * equality the store can answer by itself. Core does the rest — orders an id set by capture time,
 * intersects subjects, pages, counts and lays them out — so an id set is materialized whole on
 * every page rather than paged in the store, which holds into the low tens of thousands of media
 * per subject. A subject too large for that answers with a match instead. Asked the other way
 * round (`--of`), the module says which subjects each of a set of media has, for `--group-by`.
 */

import type { Node, NodeAttrs, NodeId } from '../../vfs/node.ts';
import type { Command } from '../../client/mod.ts';
import { lookupCommandPath } from '../../managers/shell/command-lookup.ts';
import { shq } from '../shell-quote/mod.ts';
import type { SubjectEntry, SubjectListing, SubjectMatch, SubjectsOf } from '../subjects/types.ts';
import { TEMP_PATH } from '../paths.ts';
import { classify } from './filters.ts';
import { type Candidate, type ChannelHits, CONFIDENT_NAME, sortKeyOf, wallClockOf, writeIdFile } from './sources.ts';

export type Subject = {
  kind: string;
  /** Absolute path of the subject node. */
  path: string;
  /** The subject's media, by id; empty for a subject that answered with `match`. */
  ids: Set<NodeId>;
  /** Or the attr equality that finds them. */
  match?: SubjectMatch;
  /** The module's set stopped at its ceiling, so `ids` is only a prefix. */
  truncated: boolean;
};

/** What a kind may be called: it becomes part of a command name. */
const KIND_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The command that answers for subjects of `kind` — `subject-<kind>`, when a module has one on
 * `PATH`. The lookup is memoised and dropped whenever a module is set up or removed.
 */
const subjectCommandFor = async (cmd: Command, kind: string): Promise<string | undefined> => {
  if (!KIND_NAME.test(kind)) return undefined;
  const name = `subject-${kind}`;
  return await lookupCommandPath(cmd.sys.vfs, cmd.env.PATH ?? '', name) ? name : undefined;
};

/**
 * Ask `kind`'s subject command about `refs`, all in one run: one entry per ref, in order. A ref
 * that names nothing comes back with `error`; a kind nobody answers for, or a command that fails,
 * throws.
 */
export const resolveSubjects = async (cmd: Command, kind: string, refs: readonly string[]): Promise<SubjectEntry[]> => {
  if (refs.length === 0) return [];
  const command = await subjectCommandFor(cmd, kind);
  if (!command) throw new Error(`no module answers for subjects of kind '${kind}' (no subject-${kind} on PATH)`);

  const ran = await cmd.execute(`JSON_OUTPUT=1 ${command} ${refs.map(shq).join(' ')}`);
  if (ran.code !== 0) throw new Error(`${command}: ${ran.stderr.trim() || `exit ${ran.code}`}`);
  let listing: SubjectListing;
  try {
    listing = JSON.parse(ran.stdout);
  } catch {
    throw new Error(`${command} answered invalid JSON`);
  }
  if (!Array.isArray(listing?.subjects) || listing.subjects.length !== refs.length) throw new Error(`${command} did not answer one entry per ref`);
  return listing.subjects;
};

/** Whether a module answers for subjects of `kind`: `--group-by` then asks it rather than climbing the tree. */
export const isSubjectKind = async (cmd: Command, kind: string): Promise<boolean> => await subjectCommandFor(cmd, kind) !== undefined;

/**
 * The subjects of `kind` each of `ids` (media files) has, asked of `subject-<kind> --of` with the
 * ids in a file. A kind nobody answers for, or a command that fails, throws.
 */
export const subjectsOfMedia = async (cmd: Command, kind: string, ids: readonly NodeId[]): Promise<SubjectsOf> => {
  const command = await subjectCommandFor(cmd, kind);
  if (!command) throw new Error(`no module answers for subjects of kind '${kind}' (no subject-${kind} on PATH)`);
  if (ids.length === 0) return { subjects: [], media: {} };

  const file = await writeIdFile(cmd, [...ids]);
  try {
    const ran = await cmd.execute(`JSON_OUTPUT=1 ${command} --of ${shq(file)}`);
    if (ran.code !== 0) throw new Error(`${command}: ${ran.stderr.trim() || `exit ${ran.code}`}`);
    let answer: SubjectsOf;
    try {
      answer = JSON.parse(ran.stdout);
    } catch {
      throw new Error(`${command} answered invalid JSON`);
    }
    if (!Array.isArray(answer?.subjects) || typeof answer.media !== 'object' || answer.media === null) throw new Error(`${command} --of did not answer subjects and media`);
    return answer;
  } finally {
    await cmd.sys.vfs.unlink(cmd.access, file, TEMP_PATH).catch(() => {});
  }
};

/** An entry that resolved, as a subject. */
export const subjectOf = (kind: string, entry: SubjectEntry): Subject => ({
  kind,
  path: entry.path ?? entry.ref,
  ids: new Set(entry.ids ?? []),
  ...(entry.match ? { match: entry.match } : {}),
  truncated: Boolean(entry.truncated),
});

/** Whether a node's attrs meet a subject match, as the store's `eq` would compare them. */
export const meetsMatch = (attrs: NodeAttrs, match: SubjectMatch): boolean => {
  const value = attrs[match.attr];
  return value !== undefined && value !== null && String(value) === match.value;
};

/**
 * Resolve the paths of a set of files, read their nodes, and order them by time.
 *
 * Kept apart from resolving the subject so a driver can be cut down *before* any of that: two
 * people intersect to a few hundred pictures, and resolving and reading those is nothing, where
 * doing it for the first person's whole set and rejecting most of it would be the cost of the
 * search. A hard-linked file yields each of its paths paired with the one id.
 */
export const hydrateSubjectCandidates = async (cmd: Command, ids: ReadonlySet<NodeId>, dir: 'asc' | 'desc'): Promise<Candidate[]> => {
  if (ids.size === 0) return [];
  const vfs = cmd.sys.vfs;
  const [paths, nodes] = await Promise.all([vfs.resolveIdPaths(cmd.access, [...ids]), vfs.getNodesByIds(cmd.access, [...ids])]);

  const candidates: Candidate[] = [];
  for (const [id, filePaths] of paths) {
    const node = nodes.get(id) as Node | undefined;
    if (!node || node.type !== 'file') continue;
    // Renditions and face crops are never results.
    if (node.attrs.sourceId != null) continue;

    for (const path of filePaths) candidates.push({ path, score: 1, node, sortValue: sortKeyOf(node), takenAt: wallClockOf(node), id });
  }

  // Undated media stay in the list — unlike the store-side timeline, which
  // cannot order rows that have no takenAt — but sort to the end either way.
  const sign = dir === 'asc' ? 1 : -1;
  candidates.sort((a, b) => {
    if (a.sortValue === b.sortValue) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (!a.sortValue) return 1;
    if (!b.sortValue) return -1;
    return a.sortValue < b.sortValue ? -sign : sign;
  });
  return candidates;
};

/**
 * A subject a text search named — a person, a location — brings its media with it: they are added
 * to `byPath` and ranked in the `subject` channel, each at the `name` rank of its subject (the best
 * one, when several subjects hold it).
 *
 * Typing someone's name and getting back only their person node is the wrong answer to the
 * obvious question — the pictures *of* them are what was meant, and a face is how a picture
 * knows about a person.
 *
 * Gated on a confident name match, because a weak one would flood the answer: every photo of
 * everyone whose name merely contains the query. Only a subject that answers with its media's
 * ids is expanded; one that answers with a match has no bound on its size.
 */
export const expandSubjectHits = async (
  cmd: Command,
  byPath: Map<string, Candidate>,
  names: ChannelHits,
  nameRanks: Map<string, number>,
): Promise<Map<string, number>> => {
  const confident = [...names].filter(([, hit]) => hit.score >= CONFIDENT_NAME).flatMap(([path]) => byPath.get(path) ?? []);
  // A provider hands back the id of what it matched, so the kinds cost one batched read.
  const loaded = await cmd.sys.vfs.getNodesByIds(cmd.access, confident.flatMap((candidate) => !candidate.node && candidate.id ? [candidate.id] : []));
  const byKind = new Map<string, Candidate[]>();
  for (const candidate of confident) {
    const node = candidate.node ?? (candidate.id ? loaded.get(candidate.id) : await cmd.sys.vfs.get(cmd.access, candidate.path).catch(() => undefined));
    if (!node) continue;
    const kind = classify(node.type, node.attrs.mimetype as string | undefined);
    if (!kind || !await subjectCommandFor(cmd, kind)) continue;
    byKind.set(kind, [...byKind.get(kind) ?? [], candidate]);
  }

  const ranks = new Map<string, number>();
  for (const [kind, subjects] of byKind) {
    const expandedAt = Date.now();
    // An unreadable subject contributes nothing rather than failing the search.
    const entries = await resolveSubjects(cmd, kind, subjects.map((subject) => subject.path)).catch(() => []);
    for (const [index, entry] of entries.entries()) {
      if (!entry.ids?.length) continue;
      const members = await hydrateSubjectCandidates(cmd, new Set(entry.ids), 'desc');
      if (cmd.env.SEARCH_TRACE) await cmd.writeError(`text: expand ${entry.path} ${members.length} in ${Date.now() - expandedAt}ms\n`);
      const rank = nameRanks.get(subjects[index].path);
      if (rank === undefined) continue;
      for (const member of members) {
        if (!byPath.has(member.path)) byPath.set(member.path, { ...member, score: 0 });
        ranks.set(member.path, Math.min(rank, ranks.get(member.path) ?? rank));
      }
    }
  }
  return ranks;
};
