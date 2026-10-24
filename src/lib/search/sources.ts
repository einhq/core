/**
 * Candidate sources for `search`.
 *
 * Exactly one source *drives* a query — it produces candidates in pages — and
 * every other active filter degrades to a predicate applied to those
 * candidates. This is what lets any subset of filters work on its own: with no
 * text query the timeline drives, with no filters at all the timeline still
 * drives (ordered by takenAt).
 *
 * A source hands back whatever it has; deciding what survives is the caller's
 * job (see `mod.ts`), because only the caller knows which filters are already
 * satisfied by the driver itself.
 */

import type { Node, NodeId } from '../../vfs/node.ts';
import { compareText, NAME_LANGUAGES, type NameLanguage, type NodeQueryCursor, type NodeQueryOrder } from '../../vfs/query.ts';
import { readSettings } from '../config/read-settings.ts';
import type { Command } from '../../client/mod.ts';
import { basename } from '@std/path';
import { TAGS_ROOT, TEMP_PATH } from '../paths.ts';
import { shq } from '../shell-quote/mod.ts';
import type { AttrCondition } from '../../vfs/query.ts';
import type { NodeType } from '../../vfs/node.ts';
import type { UserId } from '../mode/mod.ts';
import { type Region, regionContains } from './geo.ts';
import type { SearchChannel, SearchRankChannel } from '../api/search.ts';

export type Candidate = {
  path: string;
  score: number;
  /** Populated when the source already had it; otherwise loaded on demand. */
  node?: Node;
  /**
   * Ordering projection when the source is ordered (timeline): the **instant**,
   * `takenAtUtc`, or the `name` under a name sort. Never the wall clock — ordering
   * photographs by what their local clocks said interleaves timezones wrongly.
   */
  sortValue?: string | null;
  /**
   * The **wall clock**, `takenAt`, which is what a caller displays and buckets by.
   *
   * Carried separately from `sortValue` because the two answer different questions and a
   * candidate can arrive with one and not the other: a provider hands back both, while a
   * container listing has to load the node for either.
   */
  takenAt?: string | null;
  /**
   * Where the container that produced this candidate links it, when membership
   * is a softlink rather than the file itself living there.
   *
   * The candidate's `path` is always the file — that is its identity, and what
   * every enrichment reads. This is the other half: the edge that makes it a
   * member, and the only thing a caller may remove to unfile it.
   */
  memberPath?: string;
  /** Total members when an album-local photo stack collapses onto this candidate. */
  stackCount?: number;
  /** Node id, needed to build a keyset cursor positioned at this candidate. */
  id?: string;
  /** Position within an offset-paged source, same purpose. */
  index?: number;
  /** Coordinates resolved while region-filtering, so enrichment need not redo it. */
  point?: { lat: number; lng: number };
  /**
   * Where inside the file the match is, in seconds.
   *
   * Only a transcript chunk knows this: it is one window of a recording, so a hit on it is a
   * hit on a *moment* rather than on the whole file. Carried so the caller can open the file
   * at the words that matched instead of at the beginning of an hour of them.
   */
  atSeconds?: number;
  /** A text hit's rank in each channel that found it; see `fuseChannels`. */
  channels?: Partial<Record<SearchRankChannel, number>>;
};

export interface CandidateSource {
  readonly name: string;
  /**
   * The whole ordered set, for the sources that have one.
   *
   * Present exactly when the source is materialized rather than cursored, which
   * is also exactly when a date can be seeked to by position — see `seek`.
   */
  readonly items?: readonly Candidate[];
  /** Reposition a materialized source at an absolute index. */
  seek?(index: number): void;
  /** Returns up to `n` further candidates, or an empty array when exhausted. */
  pull(n: number): Promise<Candidate[]>;
  /**
   * Resume token positioned immediately *after* the given candidate.
   *
   * Deliberately not "the position the source has read to": the refill loop
   * over-pulls on purpose, so the source is routinely ahead of what the caller
   * actually consumed. Anchoring the cursor to a consumed candidate is what
   * keeps paging from skipping the difference.
   */
  cursorAt(candidate: Candidate): string | undefined;
  /**
   * What the providers said on stderr while answering — a content match that
   * timed out, a name lookup that failed. Each of those degrades the answer
   * without failing it, and a caller that never sees the line takes a page of
   * filename matches for the search it asked for.
   */
  warnings?: readonly string[];
}

/** The instant a node is ordered by — the same attr the store indexes on. */
export const sortKeyOf = (node: Node): string | null => (typeof node.attrs.takenAtUtc === 'string' ? node.attrs.takenAtUtc : null);

/** The wall clock a node displays and buckets under. */
export const wallClockOf = (node: Node): string | null => (typeof node.attrs.takenAt === 'string' ? node.attrs.takenAt : null);

/** The name a hit is shown and name-sorted under: its `name` attr, else the last path segment. */
export const nameOf = (node: Node | undefined, path: string): string => (typeof node?.attrs.name === 'string' ? node.attrs.name : basename(path));

/**
 * Fill in `node` and `sortValue` for candidates that arrived without them.
 *
 * Only the timeline source knows a candidate's capture time for free — it came
 * out of the ordering expression. Everything else produced a path (and sometimes
 * an id) and nothing more, so ordering those by time or name means going and
 * getting the node.
 *
 * Two round-trip shapes, because that is what the VFS offers: one batched
 * `getNodesByIds` for everything carrying an id, and parallel `get` calls for
 * the rest — each is a path walk, so they go at once rather than in a loop.
 */
export const hydrateTimes = async (cmd: Command, candidates: Candidate[]): Promise<void> => {
  const byId = candidates.filter((candidate) => !candidate.node && candidate.id);
  if (byId.length > 0) {
    const nodes = await cmd.sys.vfs.getNodesByIds(cmd.access, byId.map((candidate) => candidate.id!));
    for (const candidate of byId) candidate.node = nodes.get(candidate.id!);
  }

  const byPath = candidates.filter((candidate) => !candidate.node);
  if (byPath.length > 0) {
    const resolved = await Promise.all(byPath.map(async (candidate) => {
      try {
        return await cmd.sys.vfs.get(cmd.access, candidate.path);
      } catch {
        // Unreadable or gone: it stays undated and sorts to the end, rather
        // than failing the search.
        return undefined;
      }
    }));
    for (const [index, candidate] of byPath.entries()) candidate.node = resolved[index];
  }

  for (const candidate of candidates) {
    if (candidate.sortValue === undefined) candidate.sortValue = candidate.node ? sortKeyOf(candidate.node) : null;
    if (candidate.takenAt === undefined) candidate.takenAt = candidate.node ? wallClockOf(candidate.node) : null;
    if (candidate.node && candidate.id === undefined) candidate.id = candidate.node.id;
  }
};

/**
 * Order a materialized set by capture time, undated last whichever way it runs.
 *
 * This is what makes `--sort -time` mean the *answer* rather than the page:
 * sorting a page orders only the rows that survived onto it, which across a
 * page boundary is not an order at all.
 *
 * Path breaks ties for the same reason the text source sorts on it: paging
 * re-derives the list, and an unstable order there drops or repeats rows at the
 * boundary.
 */
export const orderByTime = (candidates: Candidate[], dir: 'asc' | 'desc'): Candidate[] => {
  const sign = dir === 'asc' ? 1 : -1;
  return [...candidates].sort((a, b) => {
    if (a.sortValue === b.sortValue) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (!a.sortValue) return 1;
    if (!b.sortValue) return -1;
    return a.sortValue < b.sortValue ? -sign : sign;
  });
};

/**
 * The language the archive is kept in (`CFG_LANGUAGE`), as names are sorted in it: English unless
 * the setting names another they can be. Read as policy, so a change reaches a shell opened before it.
 */
export const nameLanguage = async (cmd: Command): Promise<NameLanguage> => {
  const language = (await readSettings(cmd, cmd.access, { user: false })).CFG_LANGUAGE?.trim();
  return NAME_LANGUAGES.find((known) => known === language) ?? 'en';
};

/**
 * Order a materialized set by `nameOf` in `language`, as the store orders names in it, so a name
 * sort reads the same whichever source answers it; path breaks ties as in `orderByTime`.
 */
const orderByName = (candidates: Candidate[], language: NameLanguage): Candidate[] =>
  candidates
    .map((candidate) => ({ candidate, name: nameOf(candidate.node, candidate.path) }))
    .sort((a, b) => compareText(a.name, b.name, language) || (a.candidate.path < b.candidate.path ? -1 : a.candidate.path > b.candidate.path ? 1 : 0))
    .map(({ candidate }) => candidate);

/** How a materialized list is ordered before it is paged: by capture time either way, or by name. */
export type ListOrder = 'asc' | 'desc' | 'name';

/**
 * Materialize, order and wrap — the shared tail of every source that hands back
 * a list rather than a cursor.
 *
 * `order` undefined leaves the source's own order alone (score for text, path
 * for tag and geo, time for a subject or container), which is what a
 * score-ranked or unsorted search wants.
 */
export const orderedListSource = async (
  cmd: Command,
  name: string,
  items: Candidate[],
  start: number,
  order?: ListOrder,
): Promise<CandidateSource> => {
  if (!order) return listSource(name, items, start);
  await hydrateTimes(cmd, items);
  return listSource(name, order === 'name' ? orderByName(items, await nameLanguage(cmd)) : orderByTime(items, order), start);
};

/**
 * Wraps an already-materialized list as a source, paged by slicing.
 *
 * `items` is always the whole list; `start` is where a cursor says to resume.
 * The index carried on a candidate is its absolute position, since that is what
 * the next cursor is built from.
 */
export const listSource = (name: string, items: Candidate[], start = 0): CandidateSource => {
  let offset = start;
  const indexed = items.map((item, index) => ({ ...item, index }));
  return {
    name,
    items: indexed,
    seek(index: number) {
      offset = index;
    },
    pull(n: number) {
      const page = indexed.slice(offset, offset + n);
      offset += page.length;
      return Promise.resolve(page);
    },
    cursorAt: (candidate) => (candidate.index === undefined ? undefined : String(candidate.index + 1)),
  };
};

/**
 * Each channel's weight in the fusion. A channel's scores are on a scale of its own — a SigLIP2
 * cosine, a text cosine, a name ladder — so hits are only compared within a channel, by rank, and
 * a file's score is the weighted sum of `weight / (RRF_K + rank)` over the channels that found it.
 *
 * Measured on the archive's judged picture queries (ein/core#361): pictures carry search.
 * Text in a picture (`content`) helps the queries for written words at 0.3 and drowns the pictures
 * at 1; a hand-written description is about the day rather than what the picture shows, and costs
 * at more than 0.3. A name — exact or a whole-word prefix — is the best answer when there is one: at 1.5 it
 * leads alone what two similarity channels agree on, a picture's and its text's at rank 1 (1.3), and
 * costs the eval nothing at 1.5 rather than 1 (ein/core#664). The eval has nothing spoken,
 * no description of a node and no album to judge; those weights follow the measured ones
 * (ein/core#524). An album's pictures (`members`) count for less than a name: an album found
 * by its pictures alone should not tie with a person called what was asked. `subject` is the media
 * of a person, place or camera whose name matched, under the subject itself.
 */
const CHANNEL_WEIGHTS: Record<SearchRankChannel, number> = {
  picture: 1,
  content: 0.3,
  authored: 0.3,
  name: 1.5,
  description: 0.3,
  transcript: 0.3,
  members: 0.5,
  subject: 0.7,
};

/**
 * How well a name must match to be what the query means, on the `name` channel's scale: an exact
 * name is 1 and a prefix that ends a word of it 0.8; a prefix inside a word and a substring score
 * below. A name that only starts or contains the query — "fyr" in "fyra.jpg" — counts at
 * `PARTIAL_NAME_WEIGHT`: at full weight it outranked every picture (ein/core#678).
 */
export const CONFIDENT_NAME = 0.75;
const PARTIAL_NAME_WEIGHT = 0.3;

/**
 * A hit its provider marks `confident` counts as a name does, whatever its channel: a transcript
 * that says what was asked is the recording meant (ein/core#524), and a picture with the
 * word written in it is the one asked for, ahead of those the similarities found
 * (ein/core#664).
 */
const CONFIDENT_HIT_WEIGHT = CHANNEL_WEIGHTS.name;

/** The constant from the original RRF paper, which every engine that ships RRF defaults to. */
const RRF_K = 60;

const PROVIDER_CHANNELS = new Set<string>(
  ['name', 'description', 'authored', 'content', 'transcript', 'picture', 'members'] satisfies SearchChannel[],
);

/** One channel's hits, best score per path. */
export type ChannelHits = Map<string, { score: number; atSeconds?: number; confident?: boolean }>;

/** Rank 1 for the best score; path breaks ties, so the ranks are the same on every page. */
export const rankChannel = (hits: ChannelHits): Map<string, number> =>
  new Map([...hits].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).map(([path], index) => [path, index + 1]));

/** A hit's weight in the fusion: its channel's, but a partial name's less and a confident hit's more. */
const hitWeight = (channel: SearchRankChannel, hit: { score: number; confident?: boolean } | undefined): number => {
  if (channel === 'name' && hit && hit.score < CONFIDENT_NAME) return PARTIAL_NAME_WEIGHT;
  return hit?.confident ? CONFIDENT_HIT_WEIGHT : CHANNEL_WEIGHTS[channel];
};

/**
 * Weighted reciprocal-rank fusion of `ranks` into the candidates' `score`, scaled so the best is 1,
 * and each candidate's `channels`. Ordered by score, then path. `hits` are the providers' hits by
 * channel, whose scores and `confident` say a hit's weight (`hitWeight`).
 */
export const fuseChannels = (
  byPath: Map<string, Candidate>,
  ranks: Map<SearchRankChannel, Map<string, number>>,
  hits: ReadonlyMap<SearchChannel, ChannelHits> = new Map(),
): Candidate[] => {
  for (const candidate of byPath.values()) {
    candidate.score = 0;
    candidate.channels = {};
  }
  for (const [channel, ranked] of ranks) {
    for (const [path, rank] of ranked) {
      const candidate = byPath.get(path);
      if (!candidate) continue;
      const weight = hitWeight(channel, channel === 'subject' ? undefined : hits.get(channel)?.get(path));
      candidate.score += weight / (RRF_K + rank);
      candidate.channels![channel] = rank;
    }
  }
  const best = Math.max(0, ...[...byPath.values()].map((candidate) => candidate.score));
  if (best > 0) { for (const candidate of byPath.values()) candidate.score /= best; }
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
};

/**
 * Text search: fans the question out to the `search-*` providers on PATH and fuses what they found
 * by rank, channel by channel (`fuseChannels`). `question` is what each is asked, as shell words:
 * the quoted query, or `--like <path>` for the pictures that look like one.
 *
 * Providers are not cursorable, so this pulls a single generous page and then
 * reports exhaustion. That is why text ranks first as a driver — it has a hard
 * ceiling, and using it as a predicate instead would mean re-running every
 * provider per candidate.
 *
 * `start` resumes inside that one page. The fan-out is redone on every page —
 * the alternative is caching a ranked list per query across commands, and one
 * extra fan-out per "load more" is the cheaper of the two. It only works
 * because the ranking is deterministic: every rank and the final order break
 * ties by path.
 *
 * `order` re-orders the whole ranked set by capture time or name instead.
 * Providers report an `id` where they have one, so that reordering is usually one
 * batched node load rather than a walk per hit.
 *
 * `capped`: a provider said it had more than it answered, so the ranked set is a prefix of the real one.
 */
export const textSource = async (
  cmd: Command,
  question: string,
  providers: string[],
  limit: number,
  start = 0,
  order?: ListOrder,
  opts: {
    /**
     * Ranks more hits in the `subject` channel, from the `name` channel's hits and ranks; it adds
     * the candidates it ranks to `byPath`.
     */
    expand?: (byPath: Map<string, Candidate>, names: ChannelHits, nameRanks: Map<string, number>) => Promise<Map<string, number>>;
    /** Rank inside these files: the ids file, and which providers take `--within`. */
    within?: { path: string; providers: ReadonlySet<string> };
    /** Leave out what lies under these directories, at the providers that take `--not-within`. */
    notWithin?: { roots: readonly string[]; providers: ReadonlySet<string> };
  } = {},
): Promise<CandidateSource & { capped: boolean }> => {
  const byPath = new Map<string, Candidate>();
  const channels = new Map<SearchChannel, ChannelHits>();

  // Providers are independent read-only subshells, so fan them out at once
  // rather than paying each one's latency back to back.
  const startedAt = Date.now();
  const outputs = await Promise.all(
    providers.map(async (provider) => {
      const within = opts.within?.providers.has(provider) ? ` --within ${shq(opts.within.path)}` : '';
      const notWithin = opts.notWithin?.providers.has(provider) ? opts.notWithin.roots.map((root) => ` --not-within ${shq(root)}`).join('') : '';
      const output = await cmd.execute(`JSON_OUTPUT=1 ${provider} ${question} -l ${limit}${within}${notWithin}`);
      // `SEARCH_TRACE=1`: which provider the fan-out waited for.
      if (cmd.env.SEARCH_TRACE) await cmd.writeError(`text: ${provider} ${Date.now() - startedAt}ms\n`);
      return { provider, output };
    }),
  );

  const warnings = new Set<string>();
  let capped = false;
  for (const { provider, output: result } of outputs) {
    for (const line of result.stderr.split('\n')) {
      if (line.trim()) warnings.add(line.trim());
    }
    if (result.code !== 0) continue;

    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed?.results)) continue;
      if (parsed.truncated === true) capped = true;
      for (const hit of parsed.results) {
        const path = typeof hit?.path === 'string' ? hit.path : '';
        if (!path) continue;
        if (!PROVIDER_CHANNELS.has(hit?.channel)) {
          warnings.add(`${provider}: a hit in no known channel (${JSON.stringify(hit?.channel ?? null)})`);
          continue;
        }
        const channel = hit.channel as SearchChannel;
        const score = typeof hit?.score === 'number' ? hit.score : 0;
        // Providers hand back the node they matched, so an id (and sometimes a
        // capture time) costs them nothing and saves a lookup here.
        const id = typeof hit?.id === 'string' ? hit.id : undefined;
        // Both halves of the time, when the provider knows them: the wall clock to show and
        // the instant to order by. A provider that only knows one leaves the other to `enrich`.
        const takenAt = typeof hit?.takenAt === 'string' ? hit.takenAt : undefined;
        const takenAtUtc = typeof hit?.takenAtUtc === 'string' ? hit.takenAtUtc : undefined;
        const atSeconds = typeof hit?.atSeconds === 'number' ? hit.atSeconds : undefined;
        const confident = hit?.confident === true;

        // Two providers can answer the same channel (media and document both read a file's text);
        // within a channel the scales agree, so the better score is the file's.
        const hits = channels.get(channel) ?? new Map();
        channels.set(channel, hits);
        const before = hits.get(path);
        if (!before || score > before.score) hits.set(path, { score, ...(atSeconds !== undefined ? { atSeconds } : {}), ...(confident ? { confident } : {}) });

        const existing = byPath.get(path);
        if (!existing) {
          byPath.set(path, {
            path,
            score: 0,
            ...(id ? { id } : {}),
            ...(takenAtUtc ? { sortValue: takenAtUtc } : {}),
            ...(takenAt ? { takenAt } : {}),
          });
        } else {
          existing.id ??= id;
          if (existing.sortValue === undefined && takenAtUtc) existing.sortValue = takenAtUtc;
          if (existing.takenAt === undefined && takenAt) existing.takenAt = takenAt;
        }
      }
    } catch {
      // A provider that writes non-JSON on this path is skipped rather than
      // failing the whole search.
    }
  }

  const ranks = new Map<SearchRankChannel, Map<string, number>>([...channels].map(([channel, hits]) => [channel, rankChannel(hits)]));
  // A subject the query named brings its media with it — see `expandSubjectHits`.
  if (opts.expand) {
    const subject = await opts.expand(byPath, channels.get('name') ?? new Map(), ranks.get('name') ?? new Map());
    if (subject.size > 0) ranks.set('subject', subject);
  }

  // Where in a recording the words are, when what was said is one of the reasons it matched.
  for (const [path, hit] of channels.get('transcript') ?? []) {
    const candidate = byPath.get(path);
    if (candidate && hit.atSeconds !== undefined) candidate.atSeconds = hit.atSeconds;
  }

  const items = fuseChannels(byPath, ranks, channels);
  const source = await orderedListSource(cmd, 'text', items, start, order);
  return { ...source, capped, ...(warnings.size > 0 ? { warnings: [...warnings] } : {}) };
};

/**
 * A set of media ids, written where a command run by `search` can read them: a person's pictures
 * are thousands of ids, too many for a command line. `/tmp` is a memory mount; the caller removes
 * the file once the command has answered.
 */
export const writeIdFile = async (cmd: Command, ids: NodeId[]): Promise<string> => {
  const name = `search-ids-${crypto.randomUUID()}.json`;
  await cmd.sys.vfs.create(cmd.access, 'file', TEMP_PATH, name, { attrs: { name, mimetype: 'application/json' } });
  const path = `${TEMP_PATH}/${name}`;
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(JSON.stringify(ids)));
  } finally {
    await handle.close();
  }
  return path;
};

/** Paths of the softlink targets under /tags/<label>, intersected across labels. */
export const taggedPaths = async (cmd: Command, tags: string[]): Promise<Set<string>> => {
  let intersection: Set<string> | undefined;

  for (const tag of tags) {
    const targets = new Set<string>();
    try {
      const children = await cmd.sys.vfs.children(cmd.access, `${TAGS_ROOT}/${tag}`);
      for (const child of children) {
        if (child.node.props.softlink) targets.add(child.node.props.softlink);
      }
    } catch {
      // unknown tag: contributes an empty set, so the intersection empties
    }
    intersection = intersection ? new Set([...intersection].filter((p) => targets.has(p))) : targets;
  }

  return intersection ?? new Set();
};

export const tagSource = async (cmd: Command, tags: string[], offset: number, order?: ListOrder): Promise<CandidateSource> => {
  const paths = [...await taggedPaths(cmd, tags)].sort();
  return orderedListSource(cmd, 'tag', paths.map((path) => ({ path, score: 1 })), offset, order);
};

/**
 * Region search: one wide bbox scan through the position registry, then exact
 * refinement in JS.
 *
 * `findWithin` returns ids and is neither access-filtered nor sorted before it
 * truncates, so the scan limit is deliberately large and access is enforced
 * later, when the candidate's node is loaded.
 *
 * A hit is a position, and what it found is the position's parent: a file for
 * its GPS point (`<file>/position`), a location for its shape (`<location>/position`).
 */
export const geoSource = async (
  cmd: Command,
  region: Region,
  scanLimit: number,
  offset: number,
  order?: ListOrder,
): Promise<CandidateSource> => {
  const hits = await cmd.sys.vfs.findWithin(cmd.access, region.bounds, scanLimit);

  // Refine before resolving: exact containment is arithmetic, path resolution
  // is I/O, so there is no point resolving points the region rejects.
  const inside = hits.filter((hit) => regionContains(region, hit.lat, hit.lng));

  // One batched resolution for every surviving hit; one at a time, a region
  // search would take tens of seconds.
  const resolved = await cmd.sys.vfs.resolveIdEntries(cmd.access, inside.map((hit) => hit.id));

  const points = new Map<string, { lat: number; lng: number }>();
  const fileIds = new Map<string, string>();
  const paths = new Set<string>();

  for (const hit of inside) {
    for (const entry of resolved.get(hit.id) ?? []) {
      // The position's parent is the hit, and the hierarchy walk already named it.
      const path = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
      paths.add(path);
      points.set(path, { lat: hit.lat, lng: hit.lng });
      fileIds.set(path, entry.parentId);
    }
  }

  return orderedListSource(
    cmd,
    'geo',
    [...paths].sort().map((path) => ({ path, score: 1, point: points.get(path), id: fileIds.get(path) })),
    offset,
    order,
  );
};

/**
 * Timeline: the indexed attr query, and the only source with true keyset
 * paging. Time and (where expressible) kind are pushed into the store here
 * rather than filtered afterwards. It reads in `order` — capture time, or name —
 * or in node id order when there is none.
 */
export const timelineSource = (
  cmd: Command,
  opts: {
    types?: NodeType[];
    where: AttrCondition[];
    /** Only nodes this user created; a node-column filter, see `NodeQuery.birthUid`. */
    birthUid?: UserId;
    /** Only nodes in the tree under this path; see `NodeQuery.within`. */
    within?: string;
    /** Leave out the nodes in the trees under these paths; see `NodeQuery.notWithin`. */
    notWithin?: string[];
    order: NodeQueryOrder | undefined;
    after?: NodeQueryCursor;
    /**
     * Start the list at this date bound instead of at the end — `--at`.
     *
     * A keyset source has no index to seek to, so the seek is expressed the only
     * way an ordered store can express it: as another bound on the ordering
     * attr, in the direction the list runs. Reading newest-first that is
     * "older than", reading oldest-first it is "at or after".
     */
    at?: string;
    /**
     * Follow the ordered rows with matches that have no ordering value.
     *
     * The store leaves those out of an ordered query, and a list must not lose
     * them for it: a device page is a membership view, not only a timeline, so
     * suppressing a scanner's false capture date must not make the linked file
     * disappear, and a name sort still lists a place that has no name. The
     * conditions remain in both indexed queries; only the second phase drops
     * `orderBy` and asks explicitly for the missing value.
     */
    includeUnordered?: boolean;
  },
): CandidateSource => {
  let after = opts.after;
  /** The ordering attr whose missing rows follow the ordered ones, when they do. */
  const thenMissing = opts.includeUnordered ? opts.order?.ref : undefined;
  let phase: 'ordered' | 'unordered' = thenMissing !== undefined && after?.value === null ? 'unordered' : 'ordered';
  let exhausted = false;

  // Applied once, into the same condition list the time window uses — a cursor
  // then continues from wherever the seek landed, without the two fighting.
  const where = opts.at === undefined || !opts.order
    ? opts.where
    : [...opts.where, { ref: opts.order.ref, op: opts.order.dir === 'asc' ? 'gte' : 'lt', value: opts.at } as AttrCondition];

  return {
    name: 'timeline',
    async pull(n: number) {
      if (exhausted) return [];

      const candidates: Candidate[] = [];
      while (candidates.length < n && !exhausted) {
        const unordered = phase === 'unordered';
        const asked = n - candidates.length;
        const rows = await cmd.sys.vfs.query(cmd.access, {
          types: opts.types,
          birthUid: opts.birthUid,
          within: opts.within,
          ...(opts.notWithin?.length ? { notWithin: opts.notWithin } : {}),
          where: unordered ? [...opts.where, { ref: thenMissing!, op: 'missing' }] : where,
          orderBy: unordered ? undefined : opts.order,
          after,
          limit: asked,
        });

        if (rows.length > 0) {
          const last = rows[rows.length - 1];
          after = { value: last.sortValue, id: last.id };
          candidates.push(...rows.map((row) => ({
            path: row.absPath,
            score: 1,
            node: row.node,
            sortValue: row.sortValue,
            takenAt: wallClockOf(row.node),
            id: row.id,
          })));
        }

        // `query` answers fewer rows than it was asked for only when none are left.
        if (rows.length < asked) {
          if (!unordered && thenMissing !== undefined) {
            phase = 'unordered';
            after = undefined;
            continue;
          }
          exhausted = true;
        }
      }

      return candidates;
    },
    // `,` separates: a ULID never contains one, and it needs no shell quoting.
    cursorAt: (candidate) => (candidate.id === undefined ? undefined : `${candidate.id},${candidate.sortValue ?? ''}`),
  };
};

/** Inverse of `timelineSource`'s cursor encoding. */
export const parseTimelineCursor = (raw: string): NodeQueryCursor | undefined => {
  const sep = raw.indexOf(',');
  if (sep < 0) return undefined;
  return { id: raw.slice(0, sep), value: raw.slice(sep + 1) || null };
};
