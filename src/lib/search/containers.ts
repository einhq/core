/**
 * The container facet for `search`: the media held by one container, ordered by capture time.
 *
 * A sibling of `subjects.ts` — same shape, cheaper question. Where a subject is
 * a reverse lookup assembled from the backlink index, a container is a single
 * listing, so the whole set is materialized here and paged by slicing. That is
 * the same trade the subject facet makes, and it is what gives the album page
 * ordering, day grouping and paging without the browser sorting anything.
 *
 * The materialized members are kept, so the pages after the first and the album's facets do not
 * list the container and resolve every link again. A kept set is per viewer and `PATH`, holds at
 * most `CACHE_SIZE` containers, and is dropped when the VFS announces a write that can change it
 * (see `touches`), and after `CACHE_MS` at most, which covers a write it never announced.
 *
 * Two kinds of container, told apart by a command's name. A node of a type some module gives a
 * `members-<type>` command for has rules core does not know — an album's imported `files/` child,
 * its cover link, its stacks (archive's `members-album`) — so that command says who the members
 * are, and this orders and shapes them. Any other node is listed here as a **directory**: its media,
 * one level deep (subdirectories are left alone — a page renders those as folders), with softlink
 * members followed. The `members` command answers either way, for anyone else who asks.
 */

import type { NodeId } from '../../vfs/node.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { NodeEvent } from '../../vfs/types.ts';
import type { Command } from '../../client/mod.ts';
import { ADMIN_ACCESS } from '../access/constants.ts';
import { type Candidate, hydrateTimes, orderByTime } from './sources.ts';
import { lookupCommandPath } from '../../managers/shell/command-lookup.ts';
import type { ContainerListing, ContainerMember } from '../containers/types.ts';
import { isOriginalMedia } from '../media/original.ts';
import { shq } from '../shell-quote/mod.ts';

/** Ceiling on how many entries one container contributes. Mirrors SUBJECT_SCAN_LIMIT. */
export const CONTAINER_SCAN_LIMIT = 20000;

type ContainerMediaResult = {
  /** What the container shows: each folded group collapsed onto the member that stands for it. */
  candidates: Candidate[];
  /** Every member, for membership tests and for callers that want the unfolded set. */
  allCandidates: Candidate[];
  /** The candidate standing for each member path; itself for a member that is not folded. */
  frontByMemberPath: ReadonlyMap<string, Candidate>;
  /** Entries beyond the hard source ceiling exist and were not examined. */
  truncated: boolean;
};

/**
 * The media directly inside a directory, and what its softlinks point at.
 *
 * Softlink children are followed, so a directory of links — a label, an album's added
 * files — yields the same candidates a directory of files does. A followed
 * member carries both identities: `path` is the file, `memberPath` is the link
 * inside this container. Without the second one a caller has no way to unfile a
 * photo — removing the only path it was told about deletes the photo where it
 * really lives.
 */
const directoryMedia = async (cmd: Command, path: string): Promise<{ candidates: Candidate[]; truncated: boolean }> => {
  const vfs = cmd.sys.vfs;
  let entries;
  try {
    entries = await vfs.children(cmd.access, path);
  } catch {
    return { candidates: [], truncated: false };
  }

  // Conservative by design: an entry beyond the ceiling may be non-media, but
  // claiming an exact layout without examining it would be worse than falling
  // back to paging for the rare over-limit container.
  const truncated = entries.length > CONTAINER_SCAN_LIMIT;

  const candidates: Candidate[] = [];
  const links: { target: string; memberPath: string }[] = [];
  for (const entry of entries.slice(0, CONTAINER_SCAN_LIMIT)) {
    if (entry.node.props.softlink) {
      links.push({ target: entry.node.props.softlink, memberPath: `${path}/${entry.name}` });
      continue;
    }
    if (!isOriginalMedia(entry.node)) continue;
    candidates.push({ path: `${path}/${entry.name}`, score: 1, node: entry.node, id: entry.node.id as NodeId });
  }

  // Resolved in parallel rather than in the loop: each is a path walk, and a
  // directory of links is all links.
  const targets = await Promise.all(links.map(async (link) => {
    try {
      return { ...link, node: await vfs.get(cmd.access, link.target) };
    } catch {
      // A dangling or unreadable member is skipped, not an error.
      return undefined;
    }
  }));
  for (const resolved of targets) {
    if (!resolved || !isOriginalMedia(resolved.node)) continue;
    candidates.push({ path: resolved.target, memberPath: resolved.memberPath, score: 1, node: resolved.node, id: resolved.node.id as NodeId });
  }
  return { candidates, truncated };
};

/**
 * The command that lists a node of `type`'s members — `members-<type>`, when a module has one on
 * `PATH` — or undefined for a plain directory. The lookup is memoised and dropped whenever a module
 * is set up or removed, so asking it per search costs nothing.
 */
const membersCommandFor = async (cmd: Command, type: string): Promise<string | undefined> => {
  const name = `members-${type}`;
  return await lookupCommandPath(cmd.sys.vfs, cmd.env.PATH ?? '', name) ? name : undefined;
};

/** Ask the module's command who a container's members are. */
const commandMembers = async (cmd: Command, command: string, path: string): Promise<ContainerListing> => {
  const ran = await cmd.execute(`JSON_OUTPUT=1 ${command} ${shq(path)}`);
  if (ran.code !== 0) throw new Error(`${command}: ${`${ran.stderr ?? ''}`.trim() || `exit ${ran.code}`}`);
  const listing = JSON.parse(`${ran.stdout ?? ''}`) as ContainerListing;
  if (!Array.isArray(listing?.members)) throw new Error(`${command}: answered without members`);
  return listing;
};

/**
 * Fold a command's members the way it said: the visible set, and the candidate standing for each
 * member. A member whose front is not among the readable members stands for itself, so a stale
 * answer can never make a photo disappear.
 */
const fold = (members: ContainerMember[], ordered: Candidate[]): Omit<ContainerMediaResult, 'truncated'> => {
  const byPath = new Map(ordered.map((candidate) => [candidate.path, candidate]));
  const memberByPath = new Map(members.map((member) => [member.path, member]));
  const frontOf = (candidate: Candidate): Candidate => {
    const member = memberByPath.get(candidate.path);
    const frontPath = member?.front ?? candidate.path;
    const front = byPath.get(frontPath) ?? candidate;
    const count = memberByPath.get(front.path)?.stackCount;
    return count && count > 1 ? { ...front, stackCount: count } : front;
  };

  const frontByMemberPath = new Map<string, Candidate>();
  const candidates: Candidate[] = [];
  for (const candidate of ordered) {
    const front = frontOf(candidate);
    frontByMemberPath.set(candidate.path, front);
    // A hidden member leaves its front at the front's own capture-time position,
    // so list ordering and the date bucket shown for the tile agree.
    if (front.path === candidate.path) candidates.push(front);
  }
  return { candidates, allCandidates: ordered, frontByMemberPath };
};

/** A container's members before they are ordered: loaded, with their capture times. */
type Members = {
  /** Original media only, in listing order. */
  candidates: Candidate[];
  /** What a `members-<type>` command said about folding; undefined for a plain directory. */
  listing?: ContainerMember[];
  truncated: boolean;
};

const NO_MEMBERS: Members = { candidates: [], truncated: false };

/** Read who `path`'s members are and load them. */
const readMembers = async (cmd: Command, path: string): Promise<Members> => {
  let type: string | undefined;
  try {
    type = (await cmd.sys.vfs.get(cmd.access, path)).type;
  } catch {
    return NO_MEMBERS;
  }

  const command = await membersCommandFor(cmd, type);
  if (!command) {
    const { candidates, truncated } = await directoryMedia(cmd, path);
    await hydrateTimes(cmd, candidates);
    return { candidates, truncated };
  }

  const listing = await commandMembers(cmd, command, path);
  // Loaded by id in one batch: the command walked the container, this only needs the nodes.
  const all: Candidate[] = listing.members.map((member) => ({
    path: member.path,
    score: 1,
    id: member.id,
    ...(member.memberPath && member.memberPath !== member.path ? { memberPath: member.memberPath } : {}),
  }));
  await hydrateTimes(cmd, all);
  return {
    candidates: all.filter((candidate) => candidate.node && isOriginalMedia(candidate.node)),
    listing: listing.members,
    truncated: listing.truncated,
  };
};

/** How many containers' members are kept at once, least recently asked for out first. */
const CACHE_SIZE = 8;

/** How long a container's members are kept when no change to them is seen. */
const CACHE_MS = 60_000;

type Kept = {
  container: string;
  members: Promise<Members>;
  /** Every member's node id, for telling whether an event is about one. */
  ids?: ReadonlySet<NodeId>;
  at: number;
};

type Cache = {
  /** Resolves to whether the VFS announces its writes; only then is anything kept. */
  watched: Promise<boolean>;
  /** By viewer, `PATH` and container; a Map's order is the recency. */
  kept: Map<string, Kept>;
};

const caches = new WeakMap<NodeVFS, Cache>();

/** Whether `path` is `root` or lies under it. */
const within = (path: string, root: string): boolean => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * Whether `event` can change what `kept` holds: a write at or under the container (a member added
 * or removed, an album's stacks, a module's own layout under it), a write to a member wherever it
 * lives (its capture time, its mode, its removal), or the container's own path moving, going or
 * changing who may pass through it.
 */
const touches = (event: NodeEvent, kept: Kept): boolean => {
  const paths = event.fromPath === undefined ? [event.path] : [event.path, event.fromPath];
  if (paths.some((path) => within(path, kept.container))) return true;
  if (kept.ids?.has(event.node.id)) return true;
  if (!paths.some((path) => within(kept.container, path))) return false;
  if (event.type === 'moved' || event.type === 'deleted') return true;
  const before = event.previousNode?.props;
  const after = event.node.props;
  return event.type === 'updated' && (!before || before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid);
};

const cacheFor = (vfs: NodeVFS): Cache => {
  let cache = caches.get(vfs);
  if (cache) return cache;
  const kept = new Map<string, Kept>();
  const watch = async (): Promise<boolean> => {
    if (!vfs.subscribe) return false;
    await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
      for (const [key, entry] of kept) if (touches(event, entry)) kept.delete(key);
    });
    return true;
  };
  caches.set(vfs, cache = { watched: watch(), kept });
  return cache;
};

/** `readMembers`, from what is kept when it still holds. */
const members = async (cmd: Command, path: string): Promise<Members> => {
  const cache = cacheFor(cmd.sys.vfs);
  if (!await cache.watched) return await readMembers(cmd, path);

  const { uid, gid, gids, admin } = cmd.access;
  const key = JSON.stringify([uid, gid, [...gids].sort(), admin ?? false, cmd.env.PATH ?? '', path]);
  const found = cache.kept.get(key);
  if (found && Date.now() - found.at <= CACHE_MS) {
    cache.kept.delete(key);
    cache.kept.set(key, found);
    return await found.members;
  }

  const entry: Kept = { container: path, members: readMembers(cmd, path), at: Date.now() };
  cache.kept.delete(key);
  cache.kept.set(key, entry);
  while (cache.kept.size > CACHE_SIZE) cache.kept.delete(cache.kept.keys().next().value!);
  try {
    const read = await entry.members;
    entry.ids = new Set(read.candidates.flatMap((candidate) => candidate.id ?? candidate.node?.id ?? []));
    return read;
  } catch (error) {
    if (cache.kept.get(key) === entry) cache.kept.delete(key);
    throw error;
  }
};

/**
 * The media held by `path`, newest first unless `dir` says otherwise, undated last either way.
 * Candidates come back with their node loaded. They may be shared with the next search of the
 * same container, so a caller copies one before changing it.
 */
export const containerMedia = async (cmd: Command, path: string, dir: 'asc' | 'desc' = 'desc'): Promise<ContainerMediaResult> => {
  const { candidates, listing, truncated } = await members(cmd, path);
  const ordered = orderByTime(candidates, dir);
  if (!listing) return { candidates: ordered, allCandidates: ordered, frontByMemberPath: new Map(ordered.map((candidate) => [candidate.path, candidate])), truncated };
  return { ...fold(listing, ordered), truncated };
};

/**
 * Who `path`'s members are, as `members` answers: its type's `members-<type>` command's listing,
 * or for a plain directory its media and the media its softlinks point at, unordered.
 */
export const containerListing = async (cmd: Command, path: string): Promise<ContainerListing> => {
  const type = (await cmd.sys.vfs.get(cmd.access, path)).type;
  const command = await membersCommandFor(cmd, type);
  if (command) return await commandMembers(cmd, command, path);

  const { candidates, truncated } = await directoryMedia(cmd, path);
  return {
    members: candidates.flatMap((candidate) =>
      candidate.id ? [{ path: candidate.path, id: candidate.id, ...(candidate.memberPath ? { memberPath: candidate.memberPath } : {}) }] : []
    ),
    truncated,
  };
};
