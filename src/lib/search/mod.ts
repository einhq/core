/**
 * search — faceted search across content.
 *
 * Every filter works on its own: text, tags, a time window, a map region, a
 * content kind, a subject (whatever a module answers `subject-<kind>` for: a
 * person, a location, a device) and a container (an album) are independent facets,
 * and any subset is a valid query. One facet *drives* (produces candidates), the
 * rest become predicates over them. A subtree (`--within`) is the exception: it
 * narrows the time-ordered store query itself, so it combines only with the
 * facets that query can carry. Whatever drives, nothing in an unlisted tree is
 * an answer unless the subtree asked for is inside it, or a container links it
 * (`unlisted.ts`); the text providers that can are told the trees, so they spend no hits on them.
 * An attr asked to be missing (`--missing`) is a condition of the store query
 * when the timeline drives, and a test of each node otherwise.
 *
 * `-l` is a **page size**, never a scan budget. The refill loop keeps pulling
 * from the driver until the page is full or `--max-scan` is reached, which is
 * what stops a narrow filter from returning three results when fifty exist.
 */

import { basename, resolve as resolvePath } from '@std/path';
import { periodBoundsUtc } from '../capture-time/mod.ts';
import { SYSTEM_TIME_ZONE } from '../datetime/mod.ts';
import { parseArgs } from '../args/mod.ts';
import { COVER_LINK_NAME, TAGS_ROOT, TEMP_PATH } from '../paths.ts';
import { shq } from '../shell-quote/mod.ts';
import { isPinned, nodeOwnership } from '../access/verify-access.ts';
import { type AggregateBucket, assertValidAttrRef, type AttrCondition, attrRefOf, type ParentLink } from '../../vfs/query.ts';
import { matchesCondition } from '../../vfs/query-eval.ts';
import type { Node, NodeId, NodeType } from '../../vfs/node.ts';
import type { UserId } from '../mode/mod.ts';
import type { UserAttrs } from '../../vfs/types/user.ts';
import type { Command } from '../../client/mod.ts';
import type { CmdReturn } from '../../client/mod.ts';
import {
  classify,
  exclusiveUpperBound,
  FILE_KINDS,
  isKind,
  isTimeless,
  type Kind,
  kindConditions,
  kindNodeTypes,
  MEDIA_KIND_PREFIX,
  MEDIA_KINDS,
  NOT_DERIVED,
  parseDateBound,
  TAKEN_AT,
  TAKEN_AT_UTC,
  timeConditions,
} from './filters.ts';
import { parseBbox, parseCircle, parsePolygon, type Region, regionContains } from './geo.ts';
import {
  type Candidate,
  type CandidateSource,
  type ChannelHits,
  geoSource,
  type ListOrder,
  listSource,
  nameLanguage,
  nameOf,
  orderedListSource,
  parseTimelineCursor,
  taggedPaths,
  tagSource,
  textSource,
  timelineSource,
  writeIdFile,
} from './sources.ts';
import { expandSubjectHits, hydrateSubjectCandidates, isSubjectKind, meetsMatch, resolveSubjects, type Subject, subjectOf, subjectsOfMedia } from './subjects.ts';
import { CONTAINER_SCAN_LIMIT, containerMedia } from './containers.ts';
import { buildLayoutResponse, type LayoutIndexItem, type LayoutMediaKind } from './layout.ts';
import { isUnlistedPath, unlistedRoots, unlistedWithin } from './unlisted.ts';
import type { SearchHit } from '../api/search.ts';
import type { GroupTally, SearchFacetsResponse, SearchGroupsResponse, SearchResponse } from '../api/search.ts';
import { commandsNamed } from '../../managers/shell/command-lookup.ts';
export type { GroupTally } from '../api/search.ts';
export type { SearchHit } from '../api/search.ts';

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const DEFAULT_MAX_SCAN = 5000;
/**
 * Hits one text search asks each provider for, per channel.
 *
 * This is a real ceiling on a text answer, not a page size: the providers are
 * not cursorable, so the whole ranked set is pulled once and paged by slicing
 * into it. A channel matching more than this contributes its best
 * `TEXT_HIT_LIMIT` and the answer reports `truncated`, because silently returning
 * "some results" is the one thing a search must not do. `--max-scan` lowers it;
 * raising it costs a wider vector search on every page, since the fan-out is
 * redone per page.
 */
const TEXT_HIT_LIMIT = 500;
/**
 * The largest subject or container set a text search is ranked inside, handed to a text
 * provider's own `--within` as the id set `writeIdFile` writes. Beyond it the set is most of the
 * archive anyway, and the ranked page over everything is the answer.
 */
const WITHIN_LIMIT = 50000;
/**
 * Media examined when albums are found through their members (`--kind album --subject …`):
 * enough for a person's whole archive.
 */
const GROUP_MEMBER_SCAN = 100000;

/**
 * A bare date in the query text, lifted out as a time bound.
 *
 * "sailing 2011" means sailing, in 2011 — not media whose description contains
 * the characters 2011, which is what a pure text search does with it. This is
 * the one piece of the natural-language parser worth keeping without a model:
 * it is deterministic, it is visible in the answer's `filters`, and it is what
 * people actually type.
 *
 * Deliberately narrow. A four-digit year in a plausible range, or an ISO date;
 * anything vaguer ("last summer") is a guess, and this does not guess.
 */
const DATE_IN_TEXT = /(?:^|\s)(\d{4}(?:-\d{2}(?:-\d{2})?)?)(?=$|\s)/;
const MIN_YEAR = 1826;

const extractDate = (query: string): { rest: string; bound: string } | undefined => {
  const match = DATE_IN_TEXT.exec(query);
  if (!match) return undefined;
  const year = Number(match[1].slice(0, 4));
  if (!Number.isFinite(year) || year < MIN_YEAR || year > new Date().getFullYear() + 1) return undefined;
  const rest = (query.slice(0, match.index) + ' ' + query.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  return { rest, bound: match[1] };
};
/** findWithin neither sorts nor access-filters before truncating, so scan wide. */
const GEO_SCAN_LIMIT = 100000;

const asArray = (value: unknown): string[] => {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
};

/** Subjects one `--subject-name` may stand for; more is reported as `truncated`. */
const SUBJECT_NAME_MATCH_LIMIT = 50;

type SubjectGroup = {
  kind: string;
  /** The words of a `--subject-name` group; exact subjects have none. */
  name?: string;
  /** OR within one group; groups themselves are intersected. */
  subjects: Subject[];
  /** The providers found more matching subjects than the safety ceiling. */
  truncated: boolean;
};

/** `<kind>:<ref>`, split at the first colon. */
const splitKindRef = (raw: string): { kind: string; ref: string } | undefined => {
  const at = raw.indexOf(':');
  if (at < 1 || at === raw.length - 1) return undefined;
  return { kind: raw.slice(0, at), ref: raw.slice(at + 1) };
};

/**
 * Every subject of `kind` whose name matches `words`, without choosing a favourite: asked of the
 * text providers that answer the kind, then of its subject command.
 */
const resolveSubjectName = async (cmd: Command, kind: string, words: string): Promise<SubjectGroup> => {
  if (!isKind(kind)) throw new Error(`'${kind}' is not a kind`);
  const providers = await providersFor(cmd, await commandsNamed(cmd.sys.vfs, cmd.env.PATH ?? '', 'search-'), [kind]);
  if (providers.length === 0) throw new Error(`no search provider answers kind '${kind}'`);

  const ran = await Promise.all(
    providers.map((provider) => cmd.execute(`JSON_OUTPUT=1 ${provider} ${shq(words)} -l ${SUBJECT_NAME_MATCH_LIMIT + 1}`)),
  );
  if (ran.every((result) => result.code !== 0)) throw new Error(ran.map((result) => result.stderr.trim()).filter(Boolean).join('; ') || 'the providers failed');

  const scores = new Map<string, number>();
  for (const result of ran) {
    if (result.code !== 0) continue;
    let hits: { path?: unknown; score?: unknown; channel?: unknown }[] = [];
    try {
      const parsed = JSON.parse(result.stdout.trim() || '{}');
      hits = Array.isArray(parsed?.results) ? parsed.results : [];
    } catch {
      // A provider that writes non-JSON contributes nothing.
    }
    for (const hit of hits) {
      // A subject is named by what it is called, not by its description or what it is about.
      if (typeof hit.path !== 'string' || hit.channel !== 'name') continue;
      const score = typeof hit.score === 'number' ? hit.score : 0;
      scores.set(hit.path, Math.max(score, scores.get(hit.path) ?? 0));
    }
  }

  // A provider answering several kinds may match something else by the same words.
  const matched: string[] = [];
  for (const [path] of [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const node = await cmd.sys.vfs.get(cmd.access, path).catch(() => undefined);
    if (node && classify(node.type, node.attrs.mimetype as string | undefined) === kind) matched.push(path);
    if (matched.length > SUBJECT_NAME_MATCH_LIMIT) break;
  }

  const entries = await resolveSubjects(cmd, kind, matched.slice(0, SUBJECT_NAME_MATCH_LIMIT));
  // An entry with an error raced a rename or a removal: it is no longer a match.
  const subjects = entries.filter((entry) => !entry.error).map((entry) => subjectOf(kind, entry));
  return { kind, name: words, subjects, truncated: matched.length > SUBJECT_NAME_MATCH_LIMIT };
};

/**
 * What each `search-*` command says it can answer, keyed by name.
 *
 * Module scope, so it survives across `search` invocations in one instance —
 * every invocation is a fresh command process, and probing seven providers per
 * keystroke of an @-completion would cost more than the search does. Providers
 * are added by `mod setup`, not hot-swapped, so a stale entry means a restart.
 *
 * `undefined` is remembered too: it means the command is not a provider at all. A probe
 * hung up with its search is not remembered.
 */
const providerKinds = new Map<string, Kind[] | undefined>();
/** Providers whose `--kinds` answer says they rank inside a given set of ids (their own `--within`, the file `writeIdFile` writes). */
const providerWithin = new Set<string>();
/**
 * Providers whose `--kinds` answer says they leave out what lies under a directory (their own
 * `--not-within`, given once per unlisted tree), so those trees do not use up their hits.
 */
const providerNotWithin = new Set<string>();
/** Providers whose `--kinds` answer says they rank by likeness to a picture or a label (`--like`). */
const providerLike = new Set<string>();
/** Providers whose `--kinds` answer says they rank by likeness to a label only (`likeLabel`): a `--like` of a tag directory. */
const providerLikeLabel = new Set<string>();

/**
 * Ask a `search-*` command which kinds it can return, once per instance.
 *
 * Answering `--kinds` with a non-empty kind list is what makes a command a
 * provider. Anything else — a non-zero exit, no JSON, no `kinds` array — is
 * not one, and is never asked again: a `search-*` command that is not a
 * provider would otherwise run beside the real ones on every text search, and
 * be waited for, to produce output that is never a hit list.
 */
const kindsOf = async (cmd: Command, provider: string): Promise<Kind[] | undefined> => {
  if (providerKinds.has(provider)) return providerKinds.get(provider);

  let kinds: Kind[] | undefined;
  try {
    const result = await cmd.execute(`JSON_OUTPUT=1 ${provider} --kinds`);
    // A search cancelled mid-probe hung the probe up: that says nothing about the provider.
    if (cmd.interrupted) return undefined;
    if (result.code === 0) {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed?.kinds)) {
        const declared = parsed.kinds.filter((kind: unknown): kind is Kind => typeof kind === 'string' && isKind(kind));
        if (declared.length > 0) kinds = declared;
      }
      if (kinds && parsed?.within === true) providerWithin.add(provider);
      if (kinds && parsed?.notWithin === true) providerNotWithin.add(provider);
      if (kinds && parsed?.like === true) providerLike.add(provider);
      if (kinds && parsed?.likeLabel === true) providerLikeLabel.add(provider);
    }
  } catch {
    // Unparseable answer: not a provider.
  }
  if (cmd.interrupted) return undefined;

  providerKinds.set(provider, kinds);
  return kinds;
};

/**
 * The providers worth asking for this kind set.
 *
 * Every `search-*` command is probed (once per instance, all at once) and those that are
 * not providers are dropped. With no `--kind` every provider is asked. With
 * one, only the providers that can contribute are — which is what stops
 * `search x --kind photo` paying `search-people`, `search-location`,
 * `search-album` and `search-document` to each search for it and return
 * nothing usable.
 */
const providersFor = async (cmd: Command, candidates: string[], kinds: Kind[]): Promise<string[]> => {
  const wanted = new Set(kinds);
  const answers = await Promise.all(candidates.map(async (provider) => ({ provider, kinds: await kindsOf(cmd, provider) })));
  return answers
    .filter(({ kinds: declared }) => declared !== undefined && (wanted.size === 0 || declared.some((kind) => wanted.has(kind))))
    .map(({ provider }) => provider);
};

/** Loads (and memoizes) the candidate's node, enforcing read access. */
const loadNode = async (cmd: Command, candidate: Candidate): Promise<Node | undefined> => {
  if (candidate.node) return candidate.node;
  try {
    candidate.node = await cmd.sys.vfs.get(cmd.access, candidate.path);
    return candidate.node;
  } catch {
    return undefined;
  }
};

/** Reads a node's `<path>/position` child, its point. */
const readPoint = async (cmd: Command, path: string): Promise<{ lat: number; lng: number } | undefined> => {
  let handle;
  try {
    handle = await cmd.sys.vfs.open(cmd.access, `${path}/position`, { mode: 'r' });
  } catch {
    return undefined;
  }

  try {
    const data = await handle.read(4096);
    if (data.length === 0) return undefined;
    const json = JSON.parse(new TextDecoder().decode(data));
    if (typeof json?.lat !== 'number' || typeof json?.lng !== 'number') return undefined;
    return { lat: json.lat, lng: json.lng };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
};

/** Flags that always consume the next token as their value. */
const VALUE_FLAGS = [
  'limit',
  'l',
  'kind',
  'tag',
  'from',
  'to',
  'after',
  'before',
  'creator',
  'bbox',
  'circle',
  'polygon',
  'sort',
  'cursor',
  'above',
  'max-scan',
  'fields',
  'type',
  'subject',
  'subject-name',
  'group-by',
  'under',
  'within',
  'like',
  'at',
  'missing',
];

/**
 * Rewrites `--flag value` to `--flag=value` for every flag that takes one.
 *
 * @std/cli treats a value starting with `-` as the next flag, so `--sort -time`
 * would yield an empty sort (plus phantom `-t -i -m -e`), and a southern or
 * western coordinate would do the same to `--circle -33.9,18.4,500`. These flags
 * always take the following token, whatever it looks like.
 */
const joinValueFlags = (args: string[]): string[] => {
  const joined: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.startsWith('--') ? arg.slice(2) : arg.startsWith('-') ? arg.slice(1) : '';

    if (name && !name.includes('=') && VALUE_FLAGS.includes(name) && i + 1 < args.length) {
      joined.push(`${arg}=${args[++i]}`);
      continue;
    }

    joined.push(arg);
  }

  return joined;
};

/**
 * The **wall clock** a candidate is displayed and bucketed under.
 *
 * Deliberately never `candidate.sortValue`, which is the UTC instant: a day bucket, a month
 * bucket and an album's span are all questions about what the calendar said where the
 * photograph was taken, and answering them with an instant would move a midsummer evening in
 * Stockholm into the previous day.
 */
const takenAtOf = (candidate: Candidate): string | undefined => {
  const fromNode = candidate.node?.attrs.takenAt;
  if (typeof fromNode === 'string') return fromNode;
  return typeof candidate.takenAt === 'string' ? candidate.takenAt : undefined;
};

/**
 * Every distinct candidate the driver yields that passes the filters, visited
 * once.
 *
 * A full pass rather than a page, but the cheap half of one: no path
 * enrichment, no point lookups, no sorting of hits, and nodes preloaded a batch
 * at a time. The subject and container sources have already materialized their
 * whole ordered set to answer any page at all, so this costs one more walk over
 * a list that is in memory.
 *
 * Shared by `--facets` and `--group-by`, which are the same pass counting
 * different things.
 */
async function scanAll(
  cmd: Command,
  driver: CandidateSource,
  passes: (candidate: Candidate) => Promise<boolean>,
  maxScan: number,
  visit: (candidate: Candidate) => void | Promise<void>,
): Promise<{ scanned: number; truncated: boolean }> {
  const seen = new Set<string>();
  const emitted = new Set<string>();
  let scanned = 0;

  while (scanned < maxScan) {
    const got = await driver.pull(Math.min(512, maxScan - scanned));
    if (got.length === 0) break;
    scanned += got.length;

    const preloadIds = got.filter((candidate) => !candidate.node && candidate.id).map((candidate) => candidate.id!);
    if (preloadIds.length > 0) {
      const nodes = await cmd.sys.vfs.getNodesByIds(cmd.access, preloadIds);
      for (const candidate of got) {
        if (!candidate.node && candidate.id) candidate.node = nodes.get(candidate.id);
      }
    }

    for (const candidate of got) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      if (!await passes(candidate)) continue;
      if (emitted.has(candidate.path)) continue;
      emitted.add(candidate.path);
      await visit(candidate);
    }
  }

  // Whether the answer is the whole answer. A facet count that stopped at the
  // scan limit is not a total, and reporting it as one is how a camera with
  // 20k photos comes to claim it has exactly 5,000. Reaching the limit is not
  // by itself proof of more — a source that exhausts exactly there is complete
  // — so one more candidate is asked for before the answer is called a floor.
  const truncated = scanned >= maxScan && (await driver.pull(1)).length > 0;
  return { scanned, truncated };
}

/**
 * How far above a media file a group may sit before the search stops looking.
 *
 * An imported album keeps its media one level down in `files/`, so two would do;
 * the headroom is for hand-made nesting.
 */
const GROUP_LOOKUP_DEPTH = 6;

const FILE_NODE_TYPE = 'file';

/** How many link targets one backlink query asks about. */
const LINK_TARGET_CHUNK = 2000;

/**
 * Where each of a batch of media nodes is filed besides where it sits: the directories holding a
 * softlink to one of its paths, as `[media id, directory id]` pairs. A cover link names a picture
 * without filing it, so it is left out. A link below another file is found here but files
 * nothing; the climb in `groupsAbove` drops it.
 *
 * A file's paths are built from its parent links — its directories resolved once each, then its
 * name under every one — since a link may point at any of the paths a hard-linked file has.
 */
async function linkingDirs(cmd: Command, parents: Map<NodeId, ParentLink[]>): Promise<[NodeId, NodeId][]> {
  const dirIds = new Set<NodeId>();
  for (const links of parents.values()) for (const link of links) dirIds.add(link.parentId);
  const dirPaths = await cmd.sys.vfs.resolveIdEntries(cmd.access, [...dirIds]);

  const mediaByPath = new Map<string, NodeId>();
  for (const [media, links] of parents) {
    for (const link of links) {
      for (const dir of dirPaths.get(link.parentId) ?? []) mediaByPath.set(dir.path === '/' ? `/${link.name}` : `${dir.path}/${link.name}`, media);
    }
  }

  const pairs: [NodeId, NodeId][] = [];
  const paths = [...mediaByPath.keys()];
  for (let offset = 0; offset < paths.length; offset += LINK_TARGET_CHUNK) {
    const chunk = paths.slice(offset, offset + LINK_TARGET_CHUNK);
    for (const link of await cmd.sys.vfs.findLinks(cmd.access, chunk, Number.MAX_SAFE_INTEGER)) {
      if (basename(link.absPath) === COVER_LINK_NAME) continue;
      const media = mediaByPath.get(link.target);
      if (media) pairs.push([media, link.parentId]);
    }
  }
  return pairs;
}

/**
 * The groups — the nearest ancestor of one of `types` — each of a batch of media nodes is in, as
 * a map from media id: the one above where it sits, and the one above every link filing it
 * elsewhere (an album it was added to keeps a link, not the file).
 *
 * Climbs the hierarchy by id, a whole generation per round trip: the parents of
 * every candidate at once, then the ones that turned out not to be groups, and
 * so on. Bounded by `GROUP_LOOKUP_DEPTH` rather than by how much media there is,
 * so a person in a hundred and sixty albums costs the same handful of queries as
 * a person in two.
 *
 * Not a `vfs.get` per ancestor, which aggregates children it does not need, and
 * not every group indexed up front, which resolves a path per group on every call:
 * work proportional to the corpus rather than to the answer.
 */
async function groupsAbove(cmd: Command, mediaIds: NodeId[], types: ReadonlySet<string>): Promise<Map<NodeId, GroupTally[]>> {
  /** Each climb: the media it is for, and the ancestor currently being tested. */
  let climbing: [NodeId, NodeId][] = [];
  const parents = await cmd.sys.vfs.getParentLinksByIds(cmd.access, mediaIds);
  for (const [id, links] of parents) {
    // A hard-linked file hangs under several parents; the first is the one its
    // candidate path came from, and the others are the same file seen elsewhere.
    const parent = links[0]?.parentId;
    if (parent) climbing.push([id, parent]);
  }
  climbing.push(...await linkingDirs(cmd, parents));

  /** Ancestor id -> the group it turned out to be. */
  const groups = new Map<NodeId, { name: string; type: string }>();
  const found = new Map<NodeId, Set<NodeId>>();

  for (let depth = 0; depth < GROUP_LOOKUP_DEPTH && climbing.length > 0; depth++) {
    const nodes = await cmd.sys.vfs.getNodesByIds(cmd.access, [...new Set(climbing.map(([, ancestor]) => ancestor))]);

    const next: [NodeId, NodeId][] = [];
    const unresolved = new Set<NodeId>();

    for (const [media, ancestor] of climbing) {
      const node = nodes.get(ancestor);
      if (!node) continue; // unreadable ancestor — nothing above it is reachable
      if (types.has(node.type)) {
        groups.set(ancestor, { name: (node.attrs.name as string | undefined) ?? '', type: node.type });
        let held = found.get(media);
        if (!held) found.set(media, held = new Set());
        held.add(ancestor);
        continue;
      }
      // A link below a file says something about that file — a relation, a stack — and
      // files nothing: the group above it holds the file, not the link's target.
      if (node.type === FILE_NODE_TYPE) continue;
      next.push([media, ancestor]);
      unresolved.add(ancestor);
    }

    if (next.length === 0) break;

    // One more generation up, again for everything still climbing at once.
    const up = await cmd.sys.vfs.getParentLinksByIds(cmd.access, [...unresolved]);
    climbing = [];
    for (const [media, ancestor] of next) {
      const parent = up.get(ancestor)?.[0]?.parentId;
      if (parent) climbing.push([media, parent]);
    }
  }

  // Only now, and only for the groups actually hit, is a path worth building.
  const paths = await cmd.sys.vfs.resolveIdEntries(cmd.access, [...groups.keys()]);

  const tallies = new Map<NodeId, GroupTally[]>();
  for (const [media, groupIds] of found) {
    const held: GroupTally[] = [];
    for (const groupId of groupIds) {
      const path = paths.get(groupId)?.[0]?.path;
      if (!path) continue;
      const group = groups.get(groupId)!;
      held.push({ path, type: group.type, name: group.name || basename(path), count: 0 });
    }
    if (held.length > 0) tallies.set(media, held);
  }

  return tallies;
}

/**
 * The subjects of one of `kinds` — the people in a picture, the location it was taken — each of a
 * batch of media has, as a map from media id, asked of the module that answers for the kind
 * (`subject-<kind> --of`). A subject nobody has named yet is no group: the media showing one are
 * returned apart.
 */
async function subjectsAbove(cmd: Command, mediaIds: NodeId[], kinds: ReadonlySet<string>): Promise<{ held: Map<NodeId, GroupTally[]>; unnamed: Set<NodeId> }> {
  const held = new Map<NodeId, GroupTally[]>();
  const unnamed = new Set<NodeId>();
  for (const kind of kinds) {
    const answer = await subjectsOfMedia(cmd, kind, mediaIds);
    for (const [media, indexes] of Object.entries(answer.media)) {
      for (const index of indexes) {
        const subject = answer.subjects[index];
        if (!subject) continue;
        if (subject.name) held.set(media, [...held.get(media) ?? [], { path: subject.path, type: kind, name: subject.name, count: 0 }]);
        else unnamed.add(media);
      }
    }
  }
  return { held, unnamed };
}

/**
 * Which groups hold the media this query matched, with a count and a span: for a node type, the
 * nearest ancestor of that type; for a kind of subject a module answers for (`person`,
 * `location`), the subjects the media have.
 *
 * The question a person's timeline asks with `--group-by album`: not "every photo of them" but
 * "the occasions they were part of" — and, with `--group-by person`, who was there. Same pass as
 * `--facets`, grouping by container or subject instead of by month.
 *
 * A container is found by climbing the hierarchy from each file and from every link filing it,
 * batched a generation at a time — see `groupsAbove`. A file in two groups counts in both. A
 * subject nobody has named yet is not a group; `unnamed` is how many matches show one. That is a
 * count of pictures, not of people: an unnamed face may be a stranger in the background, and one
 * person's faces may be several unnamed groups.
 */
async function writeGroups(
  cmd: Command,
  driver: CandidateSource,
  passes: (candidate: Candidate) => Promise<boolean>,
  maxScan: number,
  types: ReadonlySet<string>,
): Promise<void> {
  const subjectKinds = new Set<string>();
  const containerTypes = new Set<string>();
  for (const type of types) (await isSubjectKind(cmd, type) ? subjectKinds : containerTypes).add(type);

  // Collected first, grouped second: the climb is batched, so it wants every
  // match in hand rather than one at a time.
  const matched: { id: NodeId; takenAt?: string }[] = [];
  const { truncated } = await scanAll(cmd, driver, passes, maxScan, (candidate) => {
    if (candidate.id) matched.push({ id: candidate.id, takenAt: takenAtOf(candidate) });
  });

  const ids = matched.map((match) => match.id);
  const above = containerTypes.size > 0 ? await groupsAbove(cmd, ids, containerTypes) : new Map<NodeId, GroupTally[]>();
  const subjects = subjectKinds.size > 0 ? await subjectsAbove(cmd, ids, subjectKinds) : undefined;
  for (const [media, held] of subjects?.held ?? []) above.set(media, [...above.get(media) ?? [], ...held]);

  const groups = new Map<string, GroupTally>();

  for (const match of matched) {
    for (const owner of above.get(match.id) ?? []) {
      let tally = groups.get(owner.path);
      if (!tally) {
        tally = { ...owner, count: 0 };
        groups.set(owner.path, tally);
      }
      tally.count++;

      if (!match.takenAt) continue;
      if (tally.from === undefined || match.takenAt < tally.from) tally.from = match.takenAt;
      if (tally.to === undefined || match.takenAt > tally.to) tally.to = match.takenAt;
    }
  }

  // Newest first, matching every other time-ordered answer here. A group whose
  // matching media is all undated has no span and sorts to the end.
  const list = [...groups.values()].sort((a, b) => {
    if (a.from === b.from) return a.path < b.path ? -1 : 1;
    if (!a.from) return 1;
    if (!b.from) return -1;
    return a.from < b.from ? 1 : -1;
  });

  // `truncated` as `--facets` means it: the scan stopped at `--max-scan`, so the tally is a
  // floor and a group past the limit is missing altogether — a count of occasions that does
  // not say so is a wrong count.
  if (cmd.json) {
    await cmd.writeJSON(
      {
        total: list.reduce((sum, group) => sum + group.count, 0),
        groups: list,
        ...(subjects ? { unnamed: subjects.unnamed.size } : {}),
        truncated,
      } satisfies SearchGroupsResponse,
    );
    return;
  }

  for (const group of list) {
    const span = group.from ? `${group.from.slice(0, 10)}..${(group.to ?? group.from).slice(0, 10)}` : '';
    await cmd.writeLn(`${String(group.count).padStart(6)}  ${span.padEnd(22)}  ${group.path}${subjectKinds.has(group.type) ? `  ${group.name}` : ''}`);
  }
  if (subjects?.unnamed.size) await cmd.writeLn(`(${subjects.unnamed.size} of the matches show someone nobody has named yet)`);
  if (truncated) await cmd.writeLn(`(scan stopped at --max-scan ${maxScan}; more groups may exist)`);
}

/** `YYYY-MM-DD`: the finest date bucket the rail draws. */
const DAY_PREFIX = 10;

/** What `--facets` counts, however it was counted. */
type FacetCounts = {
  total: number;
  days: Map<string, number>;
  months: Map<string, number>;
  perKind: Map<string, number>;
  /** Members carrying each label (`attrs.labels`), whatever else they carry. */
  perLabel: Map<string, number>;
  /** `total` is a floor, not a count: the walk that produced it stopped early. */
  truncated: boolean;
};

const newFacetCounts = (): FacetCounts => ({ total: 0, days: new Map(), months: new Map(), perKind: new Map(), perLabel: new Map(), truncated: false });

/**
 * Bucket one capture wall clock under its day and month.
 *
 * A partial date (`1975`, `1975-06`) has no day. A year-only date has no month
 * either; it is bucketed under a month key that is just the year, which the rail
 * reads as "sometime that year", so the years derived from the months still
 * count it.
 */
const bucketTakenAt = (counts: FacetCounts, takenAt: string, count: number): void => {
  const day = takenAt.slice(0, DAY_PREFIX);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) counts.days.set(day, (counts.days.get(day) ?? 0) + count);
  const month = takenAt.length >= 7 ? takenAt.slice(0, 7) : takenAt.slice(0, 4);
  if (!/^\d{4}(-\d{2})?$/.test(month)) return;
  counts.months.set(month, (counts.months.get(month) ?? 0) + count);
};

const countKind = (counts: FacetCounts, kind: Kind | undefined, count: number): void => {
  if (kind) counts.perKind.set(kind, (counts.perKind.get(kind) ?? 0) + count);
};

const countLabel = (counts: FacetCounts, label: string, count: number): void => {
  counts.perLabel.set(label, (counts.perLabel.get(label) ?? 0) + count);
};

/** How many labels `--facets` answers with, the most carried first. */
const LABEL_FACETS = 20;

/**
 * The store query a fully pushed-down timeline search paged over, restated so
 * the store can count it instead of the command walking it.
 *
 * Present only when every filter the driver did not satisfy is absent — the
 * predicates in `passes` are then no-ops, and what the driver would yield is
 * exactly what these conditions match.
 */
type FacetAggregate = {
  types?: NodeType[];
  birthUid?: UserId;
  within?: string;
  notWithin?: string[];
  where: AttrCondition[];
  /** Media kinds `where` could not narrow to, since several make no one condition: only files of these count. */
  kinds?: Kind[];
};

/**
 * Facets by aggregation: the whole answer in four `GROUP BY`s, with no scan
 * limit at all.
 *
 * This is what makes a device or a year with 20k photos report 20k rather than
 * `--max-scan`. Like `timeline-facets`, the counts are **not** access-filtered
 * (see NodeVFS.aggregate): they size a rail and a type filter, nothing more.
 *
 * A node's kind is its type and mimetype alone (`classify`), so the store's
 * groupings are all it needs.
 */
async function aggregateFacets(cmd: Command, spec: FacetAggregate): Promise<FacetCounts> {
  const { kinds, ...query } = spec;
  const counts = newFacetCounts();
  const vfs = cmd.sys.vfs;
  // Each of `kinds` is a named count beside the grouping, and a bucket holds what they met.
  const byKind = kinds && {
    counts: Object.fromEntries(kinds.map((kind): [string, AttrCondition[]] => [kind, [{ ref: 'mimetype', op: 'prefix', value: MEDIA_KIND_PREFIX[kind] }]])),
  };
  const met = (row: AggregateBucket): number => byKind ? Object.values(row.counts ?? {}).reduce((sum, count) => sum + count, 0) : row.count;

  // Every node has a type, so this is the one grouping that drops nothing: it
  // is the total. The non-file kinds classify by type alone, so they are
  // counted here too; files need their mimetype, which is the second query.
  const byType = await vfs.aggregate(cmd.access, { ...query, ...byKind, group: [{ column: 'type' }] });
  for (const row of byType) {
    counts.total += met(row);
    if (row.key[0] !== 'file') countKind(counts, classify(row.key[0], undefined), met(row));
  }

  const fileTypes = query.types === undefined ? ['file'] : query.types.filter((type) => type === 'file');
  if (fileTypes.length > 0) {
    const byMimetype = await vfs.aggregate(cmd.access, { ...query, types: fileTypes, group: [{ ref: 'mimetype' }] });
    for (const row of byMimetype) {
      const kind = classify('file', row.key[0]);
      if (!kinds || (kind !== undefined && kinds.includes(kind))) countKind(counts, kind, row.count);
    }
  }

  // Undated media drops out of this grouping, which is exactly the walk's
  // behaviour: counted in `total`, absent from the rail.
  const byDay = await vfs.aggregate(cmd.access, { ...query, ...byKind, group: [{ ref: TAKEN_AT, prefixLength: DAY_PREFIX }] });
  for (const row of byDay) {
    if (met(row) > 0) bucketTakenAt(counts, row.key[0], met(row));
  }

  // A label is counted where it was given: a suggestion nobody accepted is not in `labels`.
  const byLabel = await vfs.aggregate(cmd.access, { ...query, ...byKind, group: [{ ref: 'labels', each: true }] });
  for (const row of byLabel) {
    if (met(row) > 0) countLabel(counts, row.key[0], met(row));
  }

  return counts;
}

/**
 * Facets by walking: every candidate the driver yields that passes the
 * filters, bucketed one at a time.
 *
 * A materialized source (subject, container, tag, text) is walked to its end —
 * its whole set is already in memory, so `maxScan` is not a cost worth paying
 * for a wrong total — and `truncated` is then whether the *source* was capped
 * while materializing. A cursored source stops at `maxScan` and says so.
 */
async function walkFacets(
  cmd: Command,
  driver: CandidateSource,
  passes: (candidate: Candidate) => Promise<boolean>,
  maxScan: number,
  sourceTruncated: boolean,
): Promise<FacetCounts> {
  const counts = newFacetCounts();
  const materialized = driver.items !== undefined;

  const { truncated } = await scanAll(cmd, driver, passes, materialized ? driver.items!.length : maxScan, (candidate) => {
    counts.total++;
    // Counted before the date check, and so over undated media too: this is what
    // a type filter is sized from, and an album of undated scans still holds
    // documents. `passes` loaded the node to get here, so classifying is free.
    const node = candidate.node;
    if (node) countKind(counts, classify(node.type, node.attrs.mimetype as string | undefined), 1);
    const labels = node?.attrs.labels;
    if (Array.isArray(labels)) {
      for (const label of new Set(labels)) if (typeof label === 'string') countLabel(counts, label, 1);
    }

    const takenAt = takenAtOf(candidate);
    if (takenAt) bucketTakenAt(counts, takenAt, 1);
  });

  counts.truncated = sourceTruncated || (!materialized && truncated);
  return counts;
}

/**
 * Per-day, per-month and per-year counts for everything the driver yields that
 * passes the filters — what the adaptive time rail beside the results uses — and
 * the kinds and labels it is made of.
 *
 * The date buckets are shaped like `find-within --facets` and `timeline-facets`,
 * because the same rail draws all three. Undated media is left out of them — it
 * has no year to be counted under — but not out of `total`, `kinds` or `labels`.
 *
 * Counted in the store when the search is one the store can count
 * (`aggregate`), by walking the driver otherwise.
 */
async function writeFacets(
  cmd: Command,
  driver: CandidateSource,
  passes: (candidate: Candidate) => Promise<boolean>,
  maxScan: number,
  opts: { aggregate?: FacetAggregate; sourceTruncated: boolean },
): Promise<void> {
  const counts = opts.aggregate ? await aggregateFacets(cmd, opts.aggregate) : await walkFacets(cmd, driver, passes, maxScan, opts.sourceTruncated);
  const { total, truncated } = counts;

  const monthList = [...counts.months.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const dayList = [...counts.days.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const years = new Map<number, number>();
  for (const month of monthList) {
    const year = Number(month.key.slice(0, 4));
    years.set(year, (years.get(year) ?? 0) + month.count);
  }
  const yearList = [...years.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year);

  const payload = {
    total,
    range: yearList.length > 0 ? { min: yearList[0].year, max: yearList[yearList.length - 1].year } : null,
    days: dayList,
    months: monthList,
    years: yearList,
    /**
     * What the answer is made of, counted over everything that passed — dated or
     * not, just like `total`. Kinds need not sum to it because not every node is
     * a classified media kind.
     */
    kinds: [...counts.perKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    labels: [...counts.perLabel.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, LABEL_FACETS),
    /** A limit was reached somewhere: `total` is a floor, not a count. */
    truncated,
  };

  if (cmd.json) {
    await cmd.writeJSON(payload satisfies SearchFacetsResponse);
    return;
  }

  await cmd.writeLn(`total: ${total}${truncated ? '+ (scan limit reached)' : ''}`);
  if (payload.range) await cmd.writeLn(`range: ${payload.range.min}-${payload.range.max}`);
  for (const year of yearList) await cmd.writeLn(`  ${year.year}  ${year.count}`);
  for (const kind of payload.kinds) await cmd.writeLn(`${kind.kind.padEnd(12)} ${kind.count}`);
  for (const label of payload.labels) await cmd.writeLn(`#${label.label.padEnd(11)} ${label.count}`);
}

/** Where a file's renditions live: its `thumbnails/` child, which `--fields derivatives` looks for. */
const THUMBNAILS_DIR = 'thumbnails';

/** Files whose children one `getChildLinksByIds` reads, for `--fields derivatives`. */
const DERIVATIVES_BATCH = 1000;

/**
 * The complete, ordered metadata needed to lay out one source in the browser: a
 * container or a subject, which the server has already materialized and sorted,
 * or a subtree small enough (`countWithin` at most `CONTAINER_SCAN_LIMIT`) to read
 * whole from the time-ordered store query.
 *
 * Unlike ordinary result pages this is intentionally one response: paging makes
 * the server repeat that work and leaves the browser unable to know its scroll
 * extent. Media bytes are still fetched only by viewport-mounted tiles. With
 * `derivatives`, each item also says whether its file has renditions yet, from one
 * child-edge read per `DERIVATIVES_BATCH` files.
 */
async function writeLayout(
  cmd: Command,
  driver: CandidateSource,
  passes: (candidate: Candidate) => Promise<boolean>,
  sourceCount: number,
  sourceTruncated: boolean,
  derivatives: boolean,
): Promise<void> {
  const items: LayoutIndexItem[] = [];
  const ids: NodeId[] = [];
  const { truncated } = await scanAll(cmd, driver, passes, sourceCount + 1, (candidate) => {
    const node = candidate.node;
    if (!node) return;
    const mimetype = node.attrs.mimetype as string | undefined;
    const kind = classify(node.type, mimetype);
    if (kind !== 'photo' && kind !== 'video' && kind !== 'audio') return;

    const name = nameOf(node, candidate.path);
    items.push({
      path: candidate.path,
      memberPath: candidate.memberPath,
      name,
      kind: kind as LayoutMediaKind,
      mimetype,
      takenAt: takenAtOf(candidate),
      width: typeof node.attrs.width === 'number' ? node.attrs.width : undefined,
      height: typeof node.attrs.height === 'number' ? node.attrs.height : undefined,
      angle: typeof node.attrs.angle === 'number' ? node.attrs.angle : undefined,
      sar: typeof node.attrs.sar === 'number' ? node.attrs.sar : undefined,
      duration: typeof node.attrs.duration === 'number' ? node.attrs.duration : undefined,
      stackCount: candidate.stackCount,
      ownership: nodeOwnership(node),
      pinned: isPinned(node),
    });
    ids.push(node.id);
  });

  if (derivatives && !sourceTruncated && !truncated) {
    for (let start = 0; start < ids.length; start += DERIVATIVES_BATCH) {
      const children = await cmd.sys.vfs.getChildLinksByIds(cmd.access, ids.slice(start, start + DERIVATIVES_BATCH));
      for (let index = start; index < Math.min(start + DERIVATIVES_BATCH, ids.length); index++) {
        items[index].hasDerivatives = (children.get(ids[index]) ?? []).some((child) => child.name === THUMBNAILS_DIR);
      }
    }
  }

  await cmd.writeJSON(buildLayoutResponse(items, sourceTruncated || truncated));
}

/**
 * `--creator`: the user who created the node, by uid or by name.
 *
 * A name is looked up under `USERS_PATH` the way `user-whoami` does — one
 * listing of a directory with a handful of entries. Returns undefined when
 * nothing answers to it.
 */
const resolveCreator = async (cmd: Command, raw: string): Promise<UserId | undefined> => {
  if (/^\d+$/.test(raw)) return Number(raw);
  const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH).catch(() => []);
  const uid = users.find((entry) => entry.name === raw)?.node.attrs.uid;
  return typeof uid === 'number' ? uid : undefined;
};

export const search = async (cmd: Command): CmdReturn => {
  const startedAt = performance.now();
  const flags = parseArgs(joinValueFlags(cmd.args), {
    string: VALUE_FLAGS,
    // Without `collect`, @std/cli keeps only the LAST occurrence of a repeated
    // flag — so `--tag a --tag b` would silently mean just `b`.
    collect: ['tag', 'kind', 'fields', 'subject', 'subject-name', 'missing'],
    boolean: ['facets', 'layout', 'include-stacked', 'undated'],
    alias: { l: 'limit' },
  });

  const rawQuery = flags._.join(' ').trim();

  // A date typed into the box is a time filter, not text to match. Lifted out
  // before anything else sees the query, and only when the caller did not give
  // an explicit window — an explicit flag is the more specific statement.
  const dated = flags.from === undefined && flags.after === undefined && flags.to === undefined && flags.before === undefined ? extractDate(rawQuery) : undefined;
  const query = dated ? dated.rest : rawQuery;

  const limit = Math.min(Math.max(parseInt(flags.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxScan = parseInt(flags['max-scan'] ?? String(DEFAULT_MAX_SCAN), 10) || DEFAULT_MAX_SCAN;
  const tags = asArray(flags.tag);
  let creator: UserId | undefined;
  if (flags.creator !== undefined) {
    creator = await resolveCreator(cmd, flags.creator);
    if (creator === undefined) {
      await cmd.writeError(`search: creator '${flags.creator}' not found\n`);
      return 1;
    }
  }
  const fields = asArray(flags.fields).flatMap((field) => field.split(','));
  const wantDescription = fields.includes('description');
  const wantChannels = fields.includes('channels');
  const wantDerivatives = fields.includes('derivatives');

  // Kinds
  const kinds: Kind[] = [];
  for (const raw of asArray(flags.kind).flatMap((k) => k.split(','))) {
    const value = raw.trim();
    if (!value) continue;
    if (!isKind(value)) {
      await cmd.writeError(`search: '${value}' is not a kind (${FILE_KINDS.join(', ')}, or a node type)\n`);
      return 1;
    }
    if (!kinds.includes(value)) kinds.push(value);
  }

  // Attrs a match lacks: a store condition each, which a timeline carries into its own query and
  // any other driver tests on the node it reads.
  const missing = [...new Set(asArray(flags.missing).map((name) => name.trim()).filter(Boolean))];
  const missingConditions: AttrCondition[] = [];
  for (const name of missing) {
    const ref = attrRefOf(name);
    try {
      assertValidAttrRef(ref);
    } catch {
      await cmd.writeError(`search: --missing '${name}' is not an attr name (letters, digits and _, a dot between nested ones)\n`);
      return 1;
    }
    missingConditions.push({ ref, op: 'missing' });
  }

  // Time window. --after/--before are synonyms of --from/--to.
  const fromRaw = flags.from ?? flags.after ?? dated?.bound;
  const toRaw = flags.to ?? flags.before ?? dated?.bound;
  const from = fromRaw !== undefined ? parseDateBound(fromRaw) : undefined;
  const to = toRaw !== undefined ? exclusiveUpperBound(toRaw) : undefined;
  if (fromRaw !== undefined && from === undefined) {
    await cmd.writeError(`search: cannot parse --from date '${fromRaw}' (expected YYYY, YYYY-MM or YYYY-MM-DD)\n`);
    return 1;
  }
  if (toRaw !== undefined && to === undefined) {
    await cmd.writeError(`search: cannot parse --to date '${toRaw}' (expected YYYY, YYYY-MM or YYYY-MM-DD)\n`);
    return 1;
  }

  // Region
  let region: Region | undefined;
  const regionFlags = [
    ['bbox', flags.bbox, parseBbox] as const,
    ['circle', flags.circle, parseCircle] as const,
    ['polygon', flags.polygon, parsePolygon] as const,
  ].filter(([, value]) => value !== undefined);

  if (regionFlags.length > 1) {
    await cmd.writeError('search: --bbox, --circle and --polygon are mutually exclusive\n');
    return 1;
  }
  if (regionFlags.length === 1) {
    const [name, value, parse] = regionFlags[0];
    region = parse(value!);
    if (!region) {
      await cmd.writeError(`search: cannot parse --${name} '${value}'\n`);
      return 1;
    }
  }

  // Subject groups are intersected. An exact subject is a one-member group; a name is the union
  // of every subject of its kind that matches it, within one group. Thus "Olof" can mean several
  // people, while "Olof and Stina" still requires both names in the media.
  const subjectGroups: SubjectGroup[] = [];
  const subjectArgs = asArray(flags.subject);
  const subjectNameArgs = asArray(flags['subject-name']);
  const exact: { kind: string; ref: string }[] = [];
  for (const raw of subjectArgs) {
    if (raw.startsWith('/')) {
      // A path names its kind by what the node is.
      const node = await cmd.sys.vfs.get(cmd.access, raw).catch(() => undefined);
      const kind = node && classify(node.type, node.attrs.mimetype as string | undefined);
      if (!kind) {
        await cmd.writeError(`search: --subject ${raw}: ${node ? 'not a subject of any kind' : 'no such node'}\n`);
        return 1;
      }
      exact.push({ kind, ref: raw });
      continue;
    }
    const parsed = splitKindRef(raw);
    if (!parsed) {
      await cmd.writeError(`search: --subject '${raw}': expected <kind>:<ref> (person:anna) or a path\n`);
      return 1;
    }
    exact.push(parsed);
  }
  // One run of each kind's command for all its refs, then back into the order they were given.
  const exactEntries = new Map<string, Subject>();
  for (const kind of new Set(exact.map((subject) => subject.kind))) {
    const refs = exact.filter((subject) => subject.kind === kind).map((subject) => subject.ref);
    let entries;
    try {
      entries = await resolveSubjects(cmd, kind, refs);
    } catch (error) {
      await cmd.writeError(`search: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    for (const entry of entries) {
      if (entry.error) {
        await cmd.writeError(`search: ${entry.error}\n`);
        return 1;
      }
      exactEntries.set(`${kind}:${entry.ref}`, subjectOf(kind, entry));
    }
  }
  for (const { kind, ref } of exact) subjectGroups.push({ kind, subjects: [exactEntries.get(`${kind}:${ref}`)!], truncated: false });
  for (const raw of subjectNameArgs) {
    const parsed = splitKindRef(raw);
    if (!parsed) {
      await cmd.writeError(`search: --subject-name '${raw}': expected <kind>:<words> (person:anna)\n`);
      return 1;
    }
    try {
      subjectGroups.push(await resolveSubjectName(cmd, parsed.kind, parsed.ref));
    } catch (error) {
      await cmd.writeError(`search: could not match ${parsed.kind} name '${parsed.ref}': ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  // A group of subjects that answered with a match rather than ids is a store condition. One
  // group is one attr, so its subjects OR into an `in`.
  for (const group of subjectGroups) {
    const matches = group.subjects.filter((subject) => subject.match);
    if (matches.length > 0 && (matches.length < group.subjects.length || new Set(matches.map((subject) => subject.match!.attr)).size > 1)) {
      await cmd.writeError(`search: the ${group.kind} subjects of '${group.name ?? group.subjects[0].path}' do not answer alike, and cannot be one filter\n`);
      return 1;
    }
  }
  const isMatchGroup = (group: SubjectGroup): boolean => group.subjects.length > 0 && group.subjects.every((subject) => subject.match);

  const groupBy = flags['group-by'] === undefined ? undefined : new Set(flags['group-by'].split(',').map((type) => type.trim()).filter(Boolean));
  if (groupBy !== undefined && groupBy.size === 0) {
    await cmd.writeError('search: --group-by needs a node type (album)\n');
    return 1;
  }

  // Container: the media held by one album (or any directory). Unlike a subject
  // this is a place in the tree, so it resolves against the cwd like any path.
  let under: string | undefined;
  if (flags.under !== undefined) {
    under = resolvePath(cmd.cwd, flags.under);
    if (!(await cmd.sys.vfs.exists(cmd.access, under))) {
      await cmd.writeError(`search: no such container: ${flags.under}\n`);
      return 1;
    }
  }
  if (flags['include-stacked'] && under === undefined) {
    await cmd.writeError('search: --include-stacked requires --under\n');
    return 1;
  }

  // A picture to rank by instead of words: the providers that answer `like` compare every
  // picture to it. Read here, so a path the caller may not read is refused before any provider
  // is asked about it.
  let like: string | undefined;
  if (flags.like !== undefined) {
    like = resolvePath(cmd.cwd, flags.like);
    if (!(await cmd.sys.vfs.get(cmd.access, like).catch(() => undefined))) {
      await cmd.writeError(`search: --like: no such file: ${flags.like}\n`);
      return 1;
    }
    if (query) {
      await cmd.writeError('search: --like ranks by a picture and takes no words; search for one or the other\n');
      return 1;
    }
  }

  // A subtree: the media in the tree under a directory, however deep — what a folder of files
  // still to sort holds. A place rather than a membership (`--under` follows an album's links), so
  // it narrows the indexed timeline itself and is never a predicate over another driver.
  let within: string | undefined;
  if (flags.within !== undefined) {
    within = resolvePath(cmd.cwd, flags.within);
    const root = await cmd.sys.vfs.get(cmd.access, within).catch(() => undefined);
    if (!root || root.type === 'file') {
      await cmd.writeError(`search: --within needs a directory, and ${flags.within} is ${root ? 'a file' : 'not there'}\n`);
      return 1;
    }
    if (query || like !== undefined || tags.length > 0 || subjectGroups.length > 0 || under !== undefined || region !== undefined) {
      await cmd.writeError('search: --within lists a subtree by time, and takes no words, --like, --tag, --subject, --under or region\n');
      return 1;
    }
  }
  // What has no capture time: the undated tail of a timeline on its own, in the order it arrived.
  const undated = Boolean(flags.undated);
  if (undated && (fromRaw !== undefined || toRaw !== undefined || flags.at !== undefined || flags.above !== undefined)) {
    await cmd.writeError('search: --undated lists what has no date, so it takes no --from, --to, --at or --above\n');
    return 1;
  }
  // Both list media: with no kind asked, the pictures, videos and recordings, not the
  // directories, sidecars and documents beside them.
  if ((within !== undefined || undated) && kinds.length === 0) kinds.push(...MEDIA_KINDS);
  // What this view leaves out: the unlisted trees (`unlisted.ts`), or those inside the subtree
  // asked for. A container's members are what it links, wherever they are, so `--under` leaves
  // nothing out.
  const unlisted = under !== undefined ? [] : unlistedWithin(await unlistedRoots(cmd.sys.vfs), within);

  /**
   * The groups holding matching pictures, when entities are asked about with a filter only a
   * picture can meet.
   *
   * A subject, a year or an area is something a picture has, and no album carries a `takenAt`,
   * so asked of `--kind album` directly it would match nothing. A label may be on either. An
   * album answers through its members instead — the nearest album above them, which is what `--group-by album`
   * computes — so that is asked here, for each node type the kinds name; a text query still ranks
   * the entities themselves. Undefined outside that case.
   */
  let holdingGroups: GroupTally[] | undefined;
  let holdingTruncated = false;
  const pictureFiltered = subjectGroups.length > 0 || fromRaw !== undefined || toRaw !== undefined || region !== undefined || tags.length > 0;
  if (isTimeless(kinds) && pictureFiltered && within === undefined && !groupBy && !flags.facets && !flags.layout) {
    const args = ['JSON_OUTPUT=1', 'search', '--group-by', shq(kindNodeTypes(kinds).join(',')), '--kind', FILE_KINDS.join(','), '--max-scan', String(GROUP_MEMBER_SCAN)];
    for (const raw of subjectArgs) args.push('--subject', shq(raw));
    for (const raw of subjectNameArgs) args.push('--subject-name', shq(raw));
    for (const tag of tags) args.push('--tag', shq(tag));
    for (const name of missing) args.push('--missing', shq(name));
    // Joined, so a negative coordinate is not read as another flag.
    if (fromRaw !== undefined) args.push(`--from=${shq(fromRaw)}`);
    if (toRaw !== undefined) args.push(`--to=${shq(toRaw)}`);
    for (const [name, value] of regionFlags) args.push(`--${name}=${shq(value!)}`);
    const { code, stdout, stderr } = await cmd.execute(args.join(' '));
    if (code !== 0) {
      await cmd.writeError(stderr || 'search: could not find the groups holding the matches\n');
      return 1;
    }
    const answer = JSON.parse(stdout) as SearchGroupsResponse;
    holdingGroups = answer.groups;
    holdingTruncated = answer.truncated;
  }
  /**
   * The entities that meet the filter themselves rather than through pictures they hold: inside the
   * region by a position of their own, when the region is the only picture filter — a location's
   * shape is in an area itself — or carrying every label asked, when labels are. Empty otherwise:
   * such a node has no subject or date of its own to meet the rest.
   */
  const ownHits: (Candidate & { name: string })[] = [];
  const onlyPictureFilter = holdingGroups && subjectGroups.length === 0 && fromRaw === undefined && toRaw === undefined;
  if (onlyPictureFilter && region && tags.length === 0) {
    const hits = (await geoSource(cmd, region, GEO_SCAN_LIMIT, 0)).items!.filter((hit) => hit.id !== undefined);
    const nodes = await cmd.sys.vfs.getNodesByIds(cmd.access, hits.map((hit) => hit.id!));
    const types = new Set(kindNodeTypes(kinds));
    for (const hit of hits) {
      const node = nodes.get(hit.id!);
      if (node && types.has(node.type)) {
        ownHits.push({ path: hit.path, score: 0, point: hit.point, id: hit.id, name: nameOf(node, hit.path) });
      }
    }
  }
  if (holdingGroups && onlyPictureFilter && !region && tags.length > 0) {
    const holdingPaths = new Set(holdingGroups.map((group) => group.path));
    const types = new Set(kindNodeTypes(kinds));
    const paths = [...await taggedPaths(cmd, tags)].filter((path) => !holdingPaths.has(path)).sort();
    const nodes = await Promise.all(paths.map((path) => cmd.sys.vfs.get(cmd.access, path).catch(() => undefined)));
    paths.forEach((path, i) => {
      const node = nodes[i];
      if (node && types.has(node.type)) ownHits.push({ path, score: 0, id: node.id, name: nameOf(node, path) });
    });
  }
  const ownPoints = new Map(ownHits.flatMap((hit) => hit.point ? [[hit.path, hit.point] as const] : []));
  const holding = holdingGroups ? new Set([...holdingGroups.map((group) => group.path), ...ownHits.map((hit) => hit.path)]) : undefined;
  // What the pictures are asked; the groups answer the rest through `holding`.
  const pictureGroups = holding ? [] : subjectGroups;
  /** Subjects that are sets of ids: materialized, intersected, and able to drive. */
  const idGroups = pictureGroups.filter((group) => !isMatchGroup(group));
  /** Subjects that are attr equalities, as store conditions: pushed into the timeline, tested elsewhere. */
  const matchConditions: AttrCondition[] = pictureGroups.filter(isMatchGroup).map((group) => {
    const values = [...new Set(group.subjects.map((subject) => subject.match!.value))];
    const ref = group.subjects[0].match!.attr;
    return values.length === 1 ? { ref, op: 'eq', value: values[0] } : { ref, op: 'in', value: values };
  });
  const matchGroups = pictureGroups.filter(isMatchGroup);
  const pictureTags = holding ? [] : tags;
  const pictureRegion = holding ? undefined : region;

  const hasFilter = query !== '' || like !== undefined || tags.length > 0 || kinds.length > 0 ||
    from !== undefined || to !== undefined || region !== undefined ||
    creator !== undefined || subjectGroups.length > 0 || under !== undefined || within !== undefined || undated || missing.length > 0;

  // Sort: score only means something with a text query or a picture to rank by, and time only
  // means something for kinds that have one — a browse of albums, devices or tracks sorted by a
  // date they do not carry is an empty answer.
  const sort = flags.sort ?? (query || like ? 'score' : isTimeless(kinds) ? 'name' : '-time');
  if (!['score', 'time', '-time', 'name'].includes(sort)) {
    await cmd.writeError(`search: unknown sort '${sort}' (expected: score, time, -time, name)\n`);
    return 1;
  }
  if (undated && (sort === 'score' || sort === 'name')) {
    await cmd.writeError(`search: --undated lists in the order media arrived, not by ${sort}\n`);
    return 1;
  }

  /** True when the answer is ordered by capture time, which is what `--at` seeks into. */
  const timeSort = sort === 'time' || sort === '-time';

  /** The region was applied to the driving list up front, so `passes` need not test points. */
  let regionPrefiltered = false;

  /**
   * A materialized list with the region applied as set membership.
   *
   * A subject or a container is a list already in hand, ordered by time; a region is one
   * too (`geoSource` resolves every point inside it once). Testing the region row by row
   * would load each node for its point — every picture of a person, to keep the few taken in
   * one country. Two sets in memory intersect in the time it takes to build the smaller.
   */
  let regionItems: readonly Candidate[] | undefined;
  const regionSet = async (): Promise<readonly Candidate[]> => regionItems ??= (await geoSource(cmd, region!, GEO_SCAN_LIMIT, 0)).items!;
  const withinRegion = async (candidates: Candidate[]): Promise<Candidate[]> => {
    if (!region || regionPrefiltered) return candidates;
    const inside = new Map((await regionSet()).map((candidate) => [candidate.path, candidate.point]));
    regionPrefiltered = true;
    return candidates.filter((candidate) => inside.has(candidate.path)).map((candidate) => ({ ...candidate, point: inside.get(candidate.path) }));
  };
  /** The same, for a set of file ids that has no paths yet. */
  const idsWithinRegion = async (ids: Set<NodeId>): Promise<Set<NodeId>> => {
    if (!region) return ids;
    const inside = new Set((await regionSet()).map((candidate) => candidate.id).filter((id): id is NodeId => id !== undefined));
    regionPrefiltered = true;
    return new Set([...ids].filter((id) => inside.has(id)));
  };

  // Each subject's media came as ids; a name group unions its members. One group drives and
  // the rest degrade to membership tests; only the driver's nodes are ever read, and only after
  // the tests have cut it down.
  const timeDir = sort === 'time' ? 'asc' : 'desc';
  /** How a list driver orders its whole set before paging; undefined keeps its own order. */
  const listOrder: ListOrder | undefined = timeSort ? timeDir : sort === 'name' ? 'name' : undefined;
  const subjectDrives = query === '' && like === undefined && pictureTags.length === 0;
  type GroupResult = { candidates: Candidate[]; ids: Set<NodeId>; truncated: boolean };
  const groupResults = new Map<SubjectGroup, GroupResult>();
  for (const group of idGroups) {
    const ids = new Set<NodeId>();
    for (const subject of group.subjects) for (const id of subject.ids) ids.add(id);
    groupResults.set(group, { candidates: [], ids, truncated: group.truncated || group.subjects.some((subject) => subject.truncated) });
  }
  // The driving group's nodes are read only after every other group has had its say: two
  // people intersect to a few hundred pictures, and those are the ones worth reading and
  // ordering. Two sets of ids intersect in memory; two sets of nodes do not fit in it.
  if (subjectDrives && idGroups.length > 0) {
    const driving = groupResults.get(idGroups[0])!;
    const others = idGroups.slice(1).map((group) => groupResults.get(group)!.ids);
    const kept = await idsWithinRegion(new Set([...driving.ids].filter((id) => others.every((ids) => ids.has(id)))));
    driving.candidates = await hydrateSubjectCandidates(cmd, kept, timeDir);
  }

  // Same deal for a container: one listing, paged by slicing when it drives and
  // a membership test when something more selective does.
  const containerResult = under !== undefined ? await containerMedia(cmd, under, timeDir) : undefined;
  const containerSet = flags['include-stacked'] ? containerResult?.allCandidates : containerResult?.candidates;

  /**
   * The files a text or picture search may answer from, when a subject or a container says so: every
   * subject's set intersected, and the container's members. Not the region — that stays a
   * test, so this is always a superset of the answer. Undefined when nothing narrows it, or
   * when the set is too large to be worth handing over.
   */
  const textWithin = (): NodeId[] | undefined => {
    let set: Set<NodeId> | undefined;
    const narrow = (ids: Iterable<NodeId>) => {
      const next = new Set(ids);
      set = set ? new Set([...set].filter((id) => next.has(id))) : next;
    };
    for (const group of idGroups) narrow(groupResults.get(group)!.ids);
    if (containerSet) {
      const ids = containerSet.map((candidate) => candidate.id ?? candidate.node?.id);
      // A member without an id cannot be named, and leaving it out would hide it.
      if (ids.every((id) => id !== undefined)) narrow(ids as NodeId[]);
    }
    const found: Set<NodeId> | undefined = set;
    return found && found.size <= WITHIN_LIMIT ? [...found] : undefined;
  };

  // ===== Pick the driver =====
  // Priority text (or a picture to rank by) → tag → subject → geo → timeline: each is more
  // selective than the next, and the earlier ones cannot be evaluated as cheap predicates
  // anyway.
  let driver: CandidateSource;
  let driverSatisfies: 'text' | 'groups' | 'tag' | 'subject' | 'container' | 'geo' | 'timeline';
  /** A text provider had more than it answered, so the ranked set is a prefix of the real one. */
  let textCapped = false;
  let drivingSubjectGroup: SubjectGroup | undefined;
  /** What the timeline driver pages over, for `--facets` to count in the store instead. */
  let timelineQuery: FacetAggregate | undefined;
  /** The rows above a seek, read upward from its bound — set only for a seeked timeline page. */
  let lead: CandidateSource | undefined;
  const cursor = flags.cursor;

  if (flags.layout) {
    if (!cmd.json) {
      await cmd.writeError('search: --layout requires JSON_OUTPUT=1\n');
      return 1;
    }
    if (!under && !within && idGroups.length === 0) {
      await cmd.writeError('search: --layout requires --under, --within, or a --subject or --subject-name whose media is a set\n');
      return 1;
    }
    if (flags.facets || groupBy) {
      await cmd.writeError('search: --layout cannot be combined with --facets or --group-by\n');
      return 1;
    }
    if (cursor !== undefined || flags.at !== undefined) {
      await cmd.writeError('search: --layout is complete and cannot be paged or anchored\n');
      return 1;
    }
  }
  /**
   * Where this page starts in an offset-paged source.
   *
   * Reported back, because it is what a caller walking *up* the list subtracts
   * from: the cursor these sources hand out is an index into an ordered set, so
   * the page before this one is the one starting `limit` earlier.
   */
  let start = cursor !== undefined ? parseInt(cursor, 10) || 0 : 0;

  // Newest-first, a date means "start at the end of that bucket and read back",
  // so the bound is exclusive-upper. Oldest-first it means "start at the
  // beginning of it and read forward", which is the inclusive lower bound —
  // the same date, read in the direction the list runs.
  //
  // Both ends come out of `periodBoundsUtc`, in UTC, because the seek is applied to
  // `takenAtUtc` — a seek expressed in a different scale from the order it seeks into makes the
  // condition and the ORDER BY disagree, and paging then skips rows quietly. The user still
  // types a wall clock; the archive's own zone turns it into the instants that wall clock spans.
  const atBounds = flags.at === undefined ? undefined : periodBoundsUtc(flags.at.trim(), SYSTEM_TIME_ZONE);
  const at = atBounds === undefined ? undefined : timeDir === 'asc' ? atBounds.from : atBounds.to;
  if (flags.at !== undefined && at === undefined) {
    await cmd.writeError(`search: cannot parse --at date '${flags.at}' (expected YYYY[-MM[-DD[THH:MM[:SS]]]])\n`);
    return 1;
  }
  if (at !== undefined && cursor !== undefined) {
    await cmd.writeError('search: --at starts a list, --cursor continues one\n');
    return 1;
  }
  /**
   * `--above`: the page that ends just above a resume token — walking *up* a
   * keyset-paged list. The only source that cannot be paged upward by offset is
   * the timeline, so this is its counterpart to `offset`: the token is read in
   * the opposite direction and the page is turned back round before it leaves.
   */
  const above = flags.above !== undefined ? parseTimelineCursor(flags.above) : undefined;
  if (flags.above !== undefined) {
    if (above === undefined || above.value === null) {
      await cmd.writeError('search: --above needs a dated resume token from a time-ordered page\n');
      return 1;
    }
    if (cursor !== undefined || at !== undefined) {
      await cmd.writeError('search: --above pages upward on its own; not with --cursor or --at\n');
      return 1;
    }
    if (!timeSort) {
      await cmd.writeError(`search: --above needs a time sort (--sort time or -time), not '${sort}'\n`);
      return 1;
    }
  }
  // Checked before anything is fetched: a seek into an order that is not time is
  // not a seek, and silently ignoring the flag would look like one that did
  // nothing. Score-ranked and name-ordered answers have no date to land on, and
  // neither does a kind that carries no capture time.
  if (at !== undefined && !timeSort) {
    await cmd.writeError(`search: --at needs a time sort (--sort time or -time), not '${sort}'\n`);
    return 1;
  }
  if (at !== undefined && isTimeless(kinds)) {
    await cmd.writeError(`search: --at cannot seek --kind ${kinds.join(',')} — those carry no capture time\n`);
    return 1;
  }

  /**
   * Where in an ordered set a date starts.
   *
   * Newest-first, that is the first row at or older than the bound — everything
   * before it is newer, which is what scrolling back up asks for. Oldest-first
   * it is the mirror image. Undated rows sort to the end either way and are
   * never an anchor.
   */
  const offsetAt = (items: readonly Candidate[], bound: string): number => {
    const index = items.findIndex((item) => timeDir === 'asc' ? item.sortValue != null && item.sortValue >= bound : item.sortValue != null && item.sortValue < bound);
    return index < 0 ? items.length : index;
  };

  /**
   * Reposition an already-built materialized source at a date.
   *
   * The source has to exist before the index can be found — the position of a
   * date is a property of the ordered set, not something knowable up front — so
   * the seek happens after construction rather than as a constructor argument.
   */
  const seekTo = (source: CandidateSource, bound: string | undefined, current: number): number => {
    if (bound === undefined || !source.items) return current;
    const index = offsetAt(source.items, bound);
    source.seek?.(index);
    return index;
  };

  if (query || like) {
    // Every `search-*` command on PATH is a candidate; `providersFor` keeps those whose `--kinds`
    // answer says they are providers, and the ones that can answer the kinds asked for. A picture
    // to rank by goes only to the providers that say they rank by one.
    const discovered = await commandsNamed(cmd.sys.vfs, cmd.env.PATH ?? '', 'search-');
    if (discovered.length === 0) {
      await cmd.writeError('search: no search providers installed (no search-* command on PATH)\n');
      return 1;
    }
    const answering = await providersFor(cmd, discovered, kinds);
    const likeLabel = like?.startsWith(`${TAGS_ROOT}/`) === true && !like.slice(TAGS_ROOT.length + 1).includes('/');
    const providers = like ? answering.filter((provider) => providerLike.has(provider) || (likeLabel && providerLikeLabel.has(provider))) : answering;
    if (providers.length === 0) {
      const why = like
        ? `no provider ranks ${kinds.length > 0 ? `--kind ${kinds.join(',')}` : 'anything'} by a picture (--like)`
        : kinds.length > 0
        ? `no provider can answer --kind ${kinds.join(',')}`
        : 'no installed search provider answers --kinds';
      await cmd.writeError(`search: ${why}\n`);
      return 1;
    }
    // Providers are not cursorable, so this pulls one generous page up front and
    // the cursor is an offset into it — the same offset cursor tag, subject and
    // geo use.
    const textLimit = Math.min(maxScan, TEXT_HIT_LIMIT);
    // A subject or a container narrows the text to its own pictures *before* ranking: the
    // best 500 "segelbåt" of the whole archive need not include one this person is on, and a
    // filter over them then finds nothing. Providers that can rank inside a set are handed it;
    // the others answer as before and the subject tests still apply to what they return.
    const withinIds = textWithin();
    const withinPath = withinIds && providers.some((provider) => providerWithin.has(provider)) ? await writeIdFile(cmd, withinIds) : undefined;
    try {
      const question = like ? `--like ${shq(like)}` : shq(query);
      const text = await textSource(cmd, question, providers, textLimit, start, listOrder, {
        // Searching a person's name should find the pictures they are *in*, not
        // only their person node — which is what "search faces too" means in
        // practice, since a face is how a person is attached to a picture.
        //
        // Only when media is being asked for, and only for a confident name match:
        // a weak one would flood a search for "anna" with every photo of every
        // Anna-ish name in the corpus.
        ...(query && (kinds.length === 0 || kinds.some((kind) => MEDIA_KINDS.has(kind)))
          ? { expand: (byPath: Map<string, Candidate>, names: ChannelHits, nameRanks: Map<string, number>) => expandSubjectHits(cmd, byPath, names, nameRanks) }
          : {}),
        ...(withinPath ? { within: { path: withinPath, providers: providerWithin } } : {}),
        ...(unlisted.length > 0 ? { notWithin: { roots: unlisted, providers: providerNotWithin } } : {}),
      });
      driver = text;
      // A provider had more than it answered; the refill loop below can only ever report the
      // limit *it* hit, and this one is not that.
      textCapped = text.capped;
    } finally {
      if (withinPath) await cmd.sys.vfs.unlink(cmd.access, withinPath, TEMP_PATH).catch(() => {});
    }
    start = seekTo(driver, at, start);
    driverSatisfies = 'text';
  } else if (holdingGroups) {
    // Newest first as `--group-by` answers; by name unless a time sort was asked for. What meets
    // the filter itself has no time, and follows the groups.
    const groups = sort === 'time' ? [...holdingGroups].reverse() : holdingGroups;
    const named = [...groups.map((group) => ({ path: group.path, score: 0, name: group.name })), ...ownHits];
    const ordered = timeSort ? named : named.sort((a, b) => a.name.localeCompare(b.name));
    driver = listSource('groups', ordered.map(({ name: _name, ...candidate }) => candidate), start);
    driverSatisfies = 'groups';
  } else if (tags.length > 0) {
    driver = await tagSource(cmd, tags, start, listOrder);
    start = seekTo(driver, at, start);
    driverSatisfies = 'tag';
  } else if (idGroups.length > 0) {
    // Already ordered by time, and reordered whole for a name sort, so paging it
    // is a slice — same offset cursor the tag and geo sources use.
    drivingSubjectGroup = idGroups[0];
    const members = await withinRegion(groupResults.get(drivingSubjectGroup)!.candidates);
    driver = await orderedListSource(cmd, 'subject', members, start, sort === 'name' ? 'name' : undefined);
    start = seekTo(driver, at, start);
    driverSatisfies = 'subject';
  } else if (containerSet) {
    // Also already ordered by time, so this is the same slice-and-offset story.
    driver = await orderedListSource(cmd, 'container', await withinRegion(containerSet), start, sort === 'name' ? 'name' : undefined);
    start = seekTo(driver, at, start);
    driverSatisfies = 'container';
  } else if (pictureRegion) {
    driver = await geoSource(cmd, pictureRegion, GEO_SCAN_LIMIT, start, listOrder);
    start = seekTo(driver, at, start);
    driverSatisfies = 'geo';
  } else {
    // Timeline drives: time, kind and the match subjects push into the indexed store query.
    const where: AttrCondition[] = [
      NOT_DERIVED,
      ...timeConditions(from, to),
      ...kindConditions(kinds),
      ...matchConditions,
      ...(undated ? [{ ref: TAKEN_AT_UTC, op: 'missing' } as AttrCondition] : []),
      ...missingConditions,
    ];
    const types: NodeType[] | undefined = kinds.length > 0 ? kindNodeTypes(kinds) : undefined;
    // Nothing timeless has a capture time, and orderBy excludes rows missing the
    // ordering attr — so a time sort over `--kind album` (or person, location,
    // device, track) would return nothing at all. Those page on id instead,
    // which every node has.
    const timeless = isTimeless(kinds);
    const listDir = sort === 'time' ? ('asc' as const) : ('desc' as const);
    // Reading upward is the same keyset query run the other way from the token.
    const timeOrder = { ref: TAKEN_AT_UTC, dir: above ? (listDir === 'asc' ? 'desc' as const : 'asc' as const) : listDir };
    const order = undated ? undefined : sort === 'name' ? { ref: 'name', dir: 'asc' as const, collation: await nameLanguage(cmd) } : timeless ? undefined : timeOrder;
    // A match subject (a device) and a subtree are membership views as much as
    // timelines: with no explicit date window, retain their undated members after
    // the ordered part instead of letting `orderBy` erase them. A name sort does the
    // same for the nodes without a name, which a `location` is not guaranteed.
    const includeUnordered = sort === 'name' || ((matchConditions.length > 0 || within !== undefined) && from === undefined && to === undefined);
    // A seek lands a reader in the middle of history, and what they do next is
    // scroll either way. The rows above the bound are the same query read the
    // other way from it, so they come in the same answer rather than a second
    // round trip after the first has painted — see `lead` below.
    if (at !== undefined && !timeless && above === undefined) {
      lead = timelineSource(
        cmd,
        { types, where, birthUid: creator, within, notWithin: unlisted, order: { ref: TAKEN_AT_UTC, dir: listDir === 'asc' ? 'desc' : 'asc' }, at, includeUnordered: false },
      );
    }
    driver = timelineSource(
      cmd,
      {
        types,
        where,
        // The creating uid is a node column, so it rides beside the type filter
        // rather than in `where` — and it matters as much as the device does:
        // "mine" over a whole archive is the feed's newest-first question, and
        // post-filtering it would examine --max-scan rows and stop.
        birthUid: creator,
        within,
        notWithin: unlisted,
        // Ordering by takenAt excludes nodes without one, which is right for a
        // timeline but wrong when the user only asked for a kind.
        order,
        after: above ?? (cursor ? parseTimelineCursor(cursor) : undefined),
        at: timeless ? undefined : at,
        // An upward page starts inside the dated part and stays there.
        includeUnordered: includeUnordered && !above,
      },
    );
    driverSatisfies = 'timeline';
    // The same set, as conditions the store can count. Ordering silently drops
    // rows without the ordering attr, so that exclusion is spelled out here.
    timelineQuery = {
      types,
      birthUid: creator,
      within,
      notWithin: unlisted,
      where: order && !includeUnordered ? [...where, { ref: order.ref, op: 'exists' }] : where,
    };
  }

  if (above !== undefined && driverSatisfies !== 'timeline') {
    await cmd.writeError('search: --above pages the time-ordered browse; this query pages by position (see offset)\n');
    return 1;
  }

  // ===== Predicates for whatever the driver does not already satisfy =====
  const tagSet = pictureTags.length > 0 && driverSatisfies !== 'tag' ? await taggedPaths(cmd, pictureTags) : undefined;
  // A single media kind was pushed into the store query; anything else post-filters.
  const kindPushedDown = driverSatisfies === 'timeline' && kindConditions(kinds).length > 0;
  const needsKind = kinds.length > 0 && !kindPushedDown;
  // Match subjects ride in the timeline's own query and nowhere else: tested as a
  // predicate they would be bounded by --max-scan, which is what makes a camera
  // last used years ago look empty.
  const matchesPushedDown = driverSatisfies === 'timeline';
  const needsCreator = creator !== undefined && driverSatisfies !== 'timeline';
  const needsTime = (from !== undefined || to !== undefined) && driverSatisfies !== 'timeline' && !holding;
  const needsRegion = pictureRegion !== undefined && driverSatisfies !== 'geo' && !regionPrefiltered;
  const needsUndated = undated && driverSatisfies !== 'timeline';
  const missingAsPredicates = driverSatisfies === 'timeline' ? [] : missingConditions;
  const matchGroupsAsPredicates = matchesPushedDown ? [] : matchGroups;

  // Membership sets for the subjects that are not driving, so `--subject
  // person:x --subject location:y` intersects rather than picking one. By id: a
  // subject set has no paths, and a candidate that lacks an id is about to load
  // its node anyway.
  const subjectSetsAsPredicates = idGroups
    .filter((group) => group !== drivingSubjectGroup)
    .map((group) => groupResults.get(group)!.ids);

  const subjectSourceTruncated = [...groupResults.values()].some((result) => result.truncated) || holdingTruncated;

  // Membership rather than a path prefix: a container's members can be softlinks
  // pointing anywhere, so "is in this album" is not "lives under this path".
  // A map rather than a set: membership is the question here, but the value is
  // the member link, which the hits still need when something else drives.
  const containerMembers = containerResult && driverSatisfies !== 'container'
    ? new Map(containerResult.allCandidates.map((candidate) => [candidate.path, candidate]))
    : undefined;

  const passes = async (candidate: Candidate): Promise<boolean> => {
    if (isUnlistedPath(unlisted, candidate.path)) return false;
    const containerMember = containerMembers?.get(candidate.path);
    if (holding && !holding.has(candidate.path)) return false;
    if (tagSet && !tagSet.has(candidate.path)) return false;
    if (containerMembers && !containerMember) return false;
    if (candidate.id !== undefined) {
      for (const ids of subjectSetsAsPredicates) {
        if (!ids.has(candidate.id)) return false;
      }
    }

    // Every remaining predicate needs the node, which is also where read access
    // is enforced for sources that bypass it (geo).
    const node = await loadNode(cmd, candidate);
    if (!node) return false;
    if (candidate.id === undefined) {
      for (const ids of subjectSetsAsPredicates) {
        if (!ids.has(node.id)) return false;
      }
    }

    const mimetype = node.attrs.mimetype as string | undefined;

    // Renditions are never results, whatever the driver was (they carry a
    // sourceId pointing at the original they belong to).
    if (node.attrs.sourceId != null) return false;

    if (needsKind) {
      const kind = classify(node.type, mimetype);
      if (!kind || !kinds.includes(kind)) return false;
    }

    if (needsUndated && node.attrs.takenAtUtc != null) return false;
    if (missingAsPredicates.some((condition) => !matchesCondition(node.attrs, condition))) return false;

    if (needsTime) {
      // The wall clock, matching the store-side `timeConditions` this stands in for.
      const takenAt = node.attrs.takenAt as string | undefined;
      if (!takenAt) return false;
      if (from !== undefined && takenAt < from) return false;
      if (to !== undefined && takenAt >= to) return false;
    }

    for (const group of matchGroupsAsPredicates) {
      if (!group.subjects.some((subject) => meetsMatch(node.attrs, subject.match!))) return false;
    }

    if (needsCreator && node.props.birthtime.uid !== creator) return false;

    if (needsRegion) {
      // Normally free: the bbox already came from these attrs, so the exact
      // refinement is arithmetic on values in hand. The child read is only the
      // fallback for a node that does not carry its point in its attrs.
      const point = candidate.point ?? await readPoint(cmd, candidate.path);
      if (!point || !regionContains(pictureRegion!, point.lat, point.lng)) return false;
      candidate.point = point;
    }

    // When another source drove the query, predicates above deliberately saw
    // the original member: a person tagged only in the second burst frame must
    // still make the stack match. Only after it passes do we collapse that hit
    // onto the album's selected front, so the grid never sprouts a hidden tile.
    if (containerMember && containerResult && !flags['include-stacked']) {
      const front = containerResult.frontByMemberPath.get(containerMember.path);
      if (front && front.path !== candidate.path) {
        const score = candidate.score;
        Object.assign(candidate, front, { score });
        delete candidate.point;
      } else if (front?.stackCount) {
        candidate.stackCount = front.stackCount;
      }
    }

    return true;
  };

  if (flags.layout && within !== undefined) {
    // Laid out whole only when the subtree is small enough to read at once. A larger one answers
    // `truncated` at once, which tells the caller to page it instead.
    const size = await cmd.sys.vfs.countWithin(cmd.access, within, CONTAINER_SCAN_LIMIT + 1);
    if (size > CONTAINER_SCAN_LIMIT) await cmd.writeJSON(buildLayoutResponse([], true));
    else await writeLayout(cmd, driver, passes, size, false, wantDerivatives);
    return 0;
  }

  if (flags.layout) {
    const subjectResult = drivingSubjectGroup ? groupResults.get(drivingSubjectGroup) : undefined;
    const sourceCount = driverSatisfies === 'container' ? containerSet?.length : subjectResult?.candidates.length;
    if (sourceCount === undefined || (driverSatisfies !== 'container' && driverSatisfies !== 'subject')) {
      await cmd.writeError('search: --layout requires a container or subject to drive the search\n');
      return 1;
    }
    // Match the established compact-index ceiling. A larger subject keeps the
    // ordinary cursor path instead of sending an unbounded single response.
    await writeLayout(
      cmd,
      driver,
      passes,
      Math.min(sourceCount, CONTAINER_SCAN_LIMIT),
      Boolean(containerResult?.truncated) || subjectSourceTruncated || sourceCount > CONTAINER_SCAN_LIMIT,
      wantDerivatives,
    );
    return 0;
  }

  if (flags.facets) {
    // Countable in the store only when nothing is left for `passes` to reject: a set of media
    // kinds the store counts by name, and any other kind set it cannot express keeps the walk. A
    // cursor or anchor positions a *page*, and facets are never about a page.
    const mediaKinds = needsKind && kinds.every((kind) => MEDIA_KIND_PREFIX[kind] !== undefined);
    const storeCounts = (!needsKind || mediaKinds) && !needsCreator && cursor === undefined && at === undefined && above === undefined;
    await writeFacets(cmd, driver, passes, maxScan, {
      aggregate: storeCounts && timelineQuery ? { ...timelineQuery, ...(needsKind ? { kinds } : {}) } : undefined,
      sourceTruncated: textCapped || Boolean(containerResult?.truncated) || subjectSourceTruncated,
    });
    return 0;
  }

  if (groupBy) {
    await writeGroups(cmd, driver, passes, maxScan, groupBy);
    return 0;
  }

  // ===== Refill loop =====
  const seen = new Set<string>();
  const emitted = new Set<string>();
  /**
   * Pull from a source until `want` rows pass or the source or the scan budget
   * runs out. The cursor anchors on the last row *consumed*, not the source's
   * read position: the loop over-pulls deliberately, so those differ, and using
   * the read position would silently skip everything pulled but not consumed.
   */
  const fill = async (source: CandidateSource, want: number) => {
    const rows: Candidate[] = [];
    let scanned = 0;
    let truncated = false;
    let exhausted = false;
    let batch = Math.max(want, 32);
    let lastConsumed: Candidate | undefined;

    while (rows.length < want) {
      if (scanned >= maxScan) {
        truncated = true;
        break;
      }

      const got = await source.pull(Math.min(batch, maxScan - scanned));
      if (got.length === 0) {
        exhausted = true;
        break;
      }
      scanned += got.length;

      // Preload the whole batch in one round trip. Loading nodes one at a time
      // inside `passes()` would cost a `vfs.get` each, which re-walks the path
      // and re-aggregates the node's children.
      const preloadIds = got.filter((c) => !c.node && c.id).map((c) => c.id!);
      if (preloadIds.length > 0) {
        const nodes = await cmd.sys.vfs.getNodesByIds(cmd.access, preloadIds);
        for (const candidate of got) {
          if (!candidate.node && candidate.id) candidate.node = nodes.get(candidate.id);
        }
      }

      for (const candidate of got) {
        if (rows.length >= want) break;
        lastConsumed = candidate;
        if (seen.has(candidate.path)) continue;
        seen.add(candidate.path);
        if (!await passes(candidate) || emitted.has(candidate.path)) continue;
        emitted.add(candidate.path);
        rows.push(candidate);
      }

      // Widen as the filter proves selective, so a 1-in-500 filter does not do
      // 500 round trips of 32.
      batch = Math.min(batch * 2, 512);
    }

    return { rows, truncated, exhausted, lastConsumed };
  };

  const filled = await fill(driver, limit);
  let page = filled.rows;
  let truncated = filled.truncated;
  const { exhausted, lastConsumed } = filled;

  const nextCursor = exhausted || !lastConsumed ? undefined : driver.cursorAt(lastConsumed);

  // Read upward, the page came out newest-last; turn it round so it reads like
  // every other page. The row consumed last is then the one at the top of the
  // page, and the token that continues upward is positioned at it.
  if (above !== undefined) page.reverse();

  // A seeked page carries the rows above its bound as well — read upward,
  // turned round, and put in front. `anchorIndex` says where the seek itself
  // begins, so a caller can land the reader there rather than at the top.
  let anchorIndex = 0;
  let leadAbove: string | undefined;
  if (lead !== undefined) {
    const led = await fill(lead, limit);
    truncated = truncated || led.truncated;
    anchorIndex = led.rows.length;
    leadAbove = led.exhausted || !led.lastConsumed ? undefined : lead.cursorAt(led.lastConsumed);
    page = [...led.rows.reverse(), ...page];
  }
  /**
   * Where the list can still be walked upward from: above the lead after a seek,
   * at the row above the page after an upward read, and nowhere once either
   * came back empty-handed. Only the timeline driver hands these out; the offset
   * sources report `offset` instead.
   */
  const aboveCursor = driverSatisfies !== 'timeline' || timelineQuery === undefined
    ? undefined
    : above !== undefined
    ? (exhausted || !lastConsumed ? undefined : driver.cursorAt(lastConsumed))
    : leadAbove;

  // ===== Enrich =====
  const results: SearchHit[] = [];
  for (const candidate of page) {
    const node = await loadNode(cmd, candidate);
    if (!node) continue;

    const mimetype = node.attrs.mimetype as string | undefined;
    const takenAt = node.attrs.takenAt as string | undefined;
    const takenAtUtc = node.attrs.takenAtUtc as string | undefined;
    const hit: SearchHit = {
      path: candidate.path,
      kind: classify(node.type, mimetype),
      type: node.type,
      name: nameOf(node, candidate.path),
      score: candidate.score,
      ownership: nodeOwnership(node),
    };
    if (isPinned(node)) hit.pinned = true;

    const memberPath = candidate.memberPath ?? containerMembers?.get(candidate.path)?.memberPath;
    if (memberPath) hit.memberPath = memberPath;
    if (mimetype) hit.mimetype = mimetype;
    if (takenAt) hit.takenAt = takenAt;
    // Both halves travel, because a hit is also a *provider* result: `providerSource` feeds
    // these straight back in as candidates, and one that arrived with only a wall clock would
    // have to be re-read from the store before it could be ordered.
    if (takenAtUtc) hit.takenAtUtc = takenAtUtc;
    if (typeof node.attrs.width === 'number') hit.width = node.attrs.width;
    if (typeof node.attrs.height === 'number') hit.height = node.attrs.height;
    if (typeof node.attrs.angle === 'number') hit.angle = node.attrs.angle;
    if (typeof node.attrs.sar === 'number') hit.sar = node.attrs.sar;
    if (typeof node.attrs.duration === 'number') hit.duration = node.attrs.duration;
    if (candidate.stackCount !== undefined) hit.stackCount = candidate.stackCount;
    if (candidate.atSeconds !== undefined) hit.atSeconds = candidate.atSeconds;
    if (wantChannels && candidate.channels) hit.channels = candidate.channels;
    if (wantDescription && typeof node.attrs.description === 'string') {
      hit.description = node.attrs.description;
    }

    // Free from the attrs, or already resolved by the region predicate. Only a
    // node without the point in its attrs falls back to a child read.
    const point = candidate.point ?? ownPoints.get(candidate.path) ??
      (pictureRegion ? await readPoint(cmd, candidate.path) : undefined);
    if (point) {
      hit.lat = point.lat;
      hit.lng = point.lng;
    }

    results.push(hit);
  }

  // ===== Sort =====
  if (sort === 'score') {
    results.sort((a, b) => b.score - a.score);
  }
  // A time or name sort needs nothing here: every driver emits in that order.

  // A provider that degraded its answer said so on a stderr this command captured. Passed on
  // rather than swallowed: a content match that timed out leaves a page of name matches that
  // looks like a complete answer, and the reader deserves to know it is not.
  const warnings = driver.warnings ?? [];

  if (cmd.json) {
    await cmd.writeJSON(
      {
        query,
        /** Wall time this command took, so a slow answer can be seen for what it was. */
        elapsedMs: Math.round(performance.now() - startedAt),
        warnings,
        filters: {
          kinds,
          tags,
          from: from ?? null,
          to: to ?? null,
          region: region ? region.shape : null,
          creator: creator ?? null,
          subjects: subjectGroups.filter((group) => group.name === undefined).map((group) => ({ kind: group.kind, path: group.subjects[0].path })),
          subjectNames: subjectGroups.flatMap((group) =>
            group.name === undefined ? [] : [{
              kind: group.kind,
              query: group.name,
              matches: group.subjects.map((subject) => subject.path),
              truncated: group.truncated,
            }]
          ),
          under: under ?? null,
          within: within ?? null,
          missing,
          like: like ?? null,
          sort,
          /** A date lifted out of the query text, when one was. */
          dateFromQuery: dated?.bound ?? null,
        },
        truncated: truncated || textCapped || Boolean(containerResult?.truncated) || subjectSourceTruncated,
        // An upward page continues upward only; the caller keeps its own downward token.
        cursor: above !== undefined ? null : nextCursor ?? null,
        above: aboveCursor ?? null,
        /** How many rows at the front sit above a seek; 0 when the page starts where it was asked to. */
        anchorIndex,
        offset: start,
        results,
      } satisfies SearchResponse,
    );
    return 0;
  }

  for (const warning of warnings) await cmd.writeError(`search: ${warning}\n`);

  if (results.length === 0) {
    await cmd.writeLn(hasFilter ? 'No matches found.' : 'No content found.');
    return 0;
  }

  for (const hit of results) {
    const score = (hit.score * 100).toFixed(1).padStart(5);
    const when = hit.takenAt ? hit.takenAt.slice(0, 10) : '          ';
    await cmd.writeLn(`${score}%  ${when}  ${(hit.kind ?? hit.type).padEnd(8)}  ${hit.path}`);
    if (hit.description) await cmd.writeLn(`         ${hit.description}`);
    if (hit.channels) await cmd.writeLn(`         ${Object.entries(hit.channels).map(([channel, rank]) => `${channel} #${rank}`).join(', ')}`);
  }
  if (truncated) {
    await cmd.writeLn(`(scan limit ${maxScan} reached; narrow the filters or raise --max-scan)`);
  } else if (textCapped) {
    // A picture ranks the whole archive, so its answer is always the nearest few hundred.
    await cmd.writeLn(
      like
        ? `(the ${TEXT_HIT_LIMIT} pictures most like it; a filter ranks inside what it leaves)`
        : `(best ${TEXT_HIT_LIMIT} text matches per channel; narrow the query for a complete answer)`,
    );
  }

  return 0;
};

search.spec = {
  name: 'search',
  effect: 'read' as const,
  description: 'Faceted search over content: text, time, region, kind, tags, subjects (people, locations, devices) and containers',
  args: [
    { name: 'query', type: 'string' as const, description: 'search query text (optional)' },
  ],
  flags: [
    { name: 'l', type: 'number' as const, description: `page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
    { name: 'limit', type: 'number' as const, description: `page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
    { name: 'kind', type: 'string' as const, description: `content kind, comma-separated: ${FILE_KINDS.join(', ')}, or a node type (album, person, location, …)` },
    { name: 'tag', type: 'string' as const, description: 'filter by label (repeatable, intersected)', repeatable: true },
    { name: 'from', type: 'string' as const, description: 'taken at/after this date (2020, 2020-05, 2020-05-01)' },
    { name: 'to', type: 'string' as const, description: 'taken before this date, exclusive (--to 2000 includes all of 2000)' },
    { name: 'after', type: 'string' as const, description: 'alias for --from' },
    { name: 'before', type: 'string' as const, description: 'alias for --to' },
    { name: 'creator', type: 'string' as const, description: 'media created (uploaded or imported) by a user, by name or uid' },
    {
      name: 'subject',
      type: 'string' as const,
      description:
        'media a subject has, as <kind>:<slug or path> (person:anna-exempel, location:…, device:…) or a path; any kind a subject-<kind> command answers for (repeatable, intersected). For a town or country use --bbox from location-region',
      repeatable: true,
    },
    {
      name: 'subject-name',
      type: 'string' as const,
      description: 'media of any subject of a kind whose name matches, as <kind>:<words> (person:anna); repeatable groups intersect',
      repeatable: true,
    },
    { name: 'under', type: 'path' as const, description: 'media held by one album or directory (its own level; softlink members followed)' },
    { name: 'include-stacked', type: 'bool' as const, description: 'with --under, include hidden stack members (internal aggregate mode)' },
    {
      name: 'within',
      type: 'path' as const,
      description:
        "media anywhere in the tree under this directory, at any depth; by time, with the undated after the dated when there is no date window. Inside an unlisted tree (staging) it lists what the library's searches leave out",
    },
    { name: 'undated', type: 'bool' as const, description: 'only media with no capture time, in the order it arrived' },
    {
      name: 'missing',
      type: 'string' as const,
      description: 'only what lacks this attr, dotted for a nested one (duplicate.deferred); repeatable, each must be missing',
      repeatable: true,
    },
    {
      name: 'like',
      type: 'path' as const,
      description:
        "rank by how much each picture looks like this photo or video (more like this), or like a label's tag directory (/archive/tags/<label>, by its model), instead of by words; the other filters still narrow it",
    },
    { name: 'bbox', type: 'string' as const, description: 'region as north,south,east,west' },
    { name: 'circle', type: 'string' as const, description: 'region as lat,lng,radiusMeters' },
    { name: 'polygon', type: 'string' as const, description: 'region as "lat,lng;lat,lng;lat,lng"' },
    { name: 'sort', type: 'string' as const, description: 'score | time | -time | name (default: score with a query, name for timeless kinds, -time otherwise)' },
    { name: 'at', type: 'string' as const, description: 'start the page at this date (2020, 2020-05, 2020-05-01); needs a time sort' },
    { name: 'facets', type: 'bool' as const, description: 'answer with per-year, per-month, per-kind and per-label counts instead of results' },
    {
      name: 'group-by',
      type: 'string' as const,
      description:
        'answer with the groups holding the matches, counted and dated, instead of results: the nearest ancestors of these node types (album), or the subjects of these kinds the matches have (person: who is in them, and how many of them show someone nobody has named)',
    },
    { name: 'layout', type: 'bool' as const, description: 'answer with one compact complete layout index for a container or a subject (JSON only)' },
    { name: 'cursor', type: 'string' as const, description: 'resume token from a previous page (a position, for --subject/--under)' },
    { name: 'above', type: 'string' as const, description: 'the page ending just above this resume token — walking up a time-ordered browse' },
    {
      name: 'max-scan',
      type: 'number' as const,
      description: `candidates to examine before giving up (default ${DEFAULT_MAX_SCAN}); store-counted and materialized facets are exact regardless`,
    },
    {
      name: 'fields',
      type: 'string' as const,
      description:
        "extra fields to include: description, channels (a text hit's rank in each channel that found it), derivatives (with --layout: whether each file has renditions yet)",
    },
  ],
  examples: [
    'search segelbåt --kind photo',
    'search --subject person:anna-exempel --subject person:bo-exempel --kind photo --sort -time',
    "search --subject-name 'person:anna' --kind video",
    'search --bbox=$(location-region Exempelstad --bbox-only) --from 2007 --to 2007',
    'search --subject person:anna-exempel --group-by album',
    'search --under /archive/albums/Exempelalbum --group-by person',
    'search --like /archive/albums/Exempelalbum/files/IMG_0001.jpg --subject person:anna-exempel',
    'search --within /home/anna/staging/files --sort time',
    'search --within /home/anna/staging/files --undated --facets',
    'search --within /home/anna/staging/files --missing duplicate.deferred',
  ],
  returns:
    'a page of matching media, each with its path, name and date; with --group-by the albums (or other containers) holding the matches, or the people in them, instead, counted and dated; with --facets per-year, per-kind and per-label counts.',
};
