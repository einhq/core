/**
 * Node attribute queries
 *
 * An indexed way to enumerate nodes by their attrs, without walking the tree.
 * Deliberately not a general query DSL: conditions are AND-ed, never nested,
 * and there is no OR. A filter that needs OR belongs in a separate query whose
 * results are merged by the caller.
 *
 * All comparisons are **text** comparisons, matching PostgreSQL's `->>`
 * projection (and `COLLATE "C"`, so ranges are byte-ordered). Numbers passed as
 * values are stringified on both sides. This is what ISO timestamps and
 * mimetypes want; numeric range conditions would need a cast and are not
 * supported yet.
 *
 * The exceptions are `contains`, which folds case — it exists to answer a person
 * typing into a search box, not to order a range — and an order in a language's
 * collation, which sorts as that language's readers expect a list of names to be sorted.
 */

import type { UserId } from '../lib/mode/mod.ts';
import type { Node, NodeAttrs, NodeId, NodePath, NodeType } from './node.ts';

/**
 * Which attribute a condition reads.
 *
 * `{ path: [...] }` descends through nested objects, so
 * `{ path: ['relation', 'from'] }` reads `attrs.relation.from`.
 *
 * `{ coalesce: [...] }` takes the first attr that is present and non-null,
 * which is how `takenAtManual ?? takenAt` is expressed.
 */
export type AttrPathRef = string | { path: string[] };
export type AttrRef = AttrPathRef | { coalesce: AttrPathRef[] };

export type AttrCondition =
  /** Strict: a missing attr never matches `eq`. */
  | { ref: AttrRef; op: 'eq'; value: string | number | boolean }
  /** Lenient: a missing attr **does** match `ne` (missing !== anything). */
  | { ref: AttrRef; op: 'ne'; value: string | number | boolean }
  | { ref: AttrRef; op: 'gte' | 'gt' | 'lte' | 'lt'; value: string | number }
  /** Rewritten to a `>= p AND < upperBound(p)` range so an index can serve it. */
  | { ref: AttrRef; op: 'prefix'; value: string }
  /**
   * Case-insensitive substring match — the operator behind every name search
   * box. The one condition that is **not** a byte comparison: it folds case on
   * both sides, and LIKE metacharacters in the value are literal text.
   *
   * Served by a trigram index where the store has one (`pg_trgm`); elsewhere
   * it is one sequential scan of the attrs table, which is still a single bounded query
   * rather than a caller-side paged walk. PostgreSQL can only use the trigram
   * index for values of three characters or more — a shorter one degrades to
   * that scan, and stops early because it matches almost everything.
   */
  | { ref: AttrRef; op: 'contains'; value: string }
  | { ref: AttrRef; op: 'in'; value: (string | number)[] }
  /**
   * An element of the attr is the value: an array is read element by element and a scalar as a
   * one-element array, as an `each` group reads it. What finds the nodes carrying a label.
   */
  | { ref: AttrRef; op: 'has'; value: string | number }
  | { ref: AttrRef; op: 'exists' | 'missing' };

/** The languages names can be sorted in, by their BCP 47 tags; the archive's is `CFG_LANGUAGE`. */
export const NAME_LANGUAGES = ['en', 'sv'] as const;

export type NameLanguage = (typeof NAME_LANGUAGES)[number];

/**
 * How an order compares text. `bytes` compares code by code: what dates, ids and ranges need, and
 * what every attr index holds unless it says otherwise. A language sorts names as its readers do:
 * letters before case, so "anna" and "Anna" sit together before "Bo"; in `sv` Å, Ä, Ö follow Z in
 * that order, where `en` files them under A and O.
 */
export type NodeQueryCollation = 'bytes' | NameLanguage;

/**
 * The order of a query; `collation` defaults to `bytes`. With `match`, rows are ordered by how well
 * the attr matches that text (`MatchRank`) rather than by the attr, and `collation` is not used.
 */
export type NodeQueryOrder = { ref: AttrRef; dir: 'asc' | 'desc'; collation?: NodeQueryCollation; match?: string };

/**
 * How well a value matches a text, case folded on both sides, best first: the sort value of an
 * order with `match`. `0` the value is the text, or is the text and an extension (a dot and one to
 * five letters or digits) — a file named the text; `1` it starts with the text; `2` it holds it
 * elsewhere; `3` it does not hold it.
 */
type MatchRank = '0' | '1' | '2' | '3';

/** The extension `MatchRank` looks past; the SQL builder spells the same pattern. */
export const MATCH_EXTENSION = /\.[a-z0-9]{1,5}$/;

export const matchRank = (value: string, text: string): MatchRank => {
  const folded = value.toLowerCase();
  const wanted = text.toLowerCase();
  if (folded === wanted || folded.replace(MATCH_EXTENSION, '') === wanted) return '0';
  if (folded.startsWith(wanted)) return '1';
  return folded.includes(wanted) ? '2' : '3';
};

const collators = new Map<NameLanguage, Intl.Collator>();

/**
 * `a` against `b` under `collation`, negative when `a` sorts first. Two texts the collator holds
 * equal fall back to code order, so only identical texts tie — as in PostgreSQL's ICU collations,
 * which are deterministic.
 */
export const compareText = (a: string, b: string, collation: NodeQueryCollation = 'bytes'): number => {
  if (collation !== 'bytes') {
    let collator = collators.get(collation);
    if (!collator) collators.set(collation, collator = new Intl.Collator(collation));
    const byName = collator.compare(a, b);
    if (byName) return byName;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Keyset cursor: resume strictly after this (sortValue, id) pair. */
export type NodeQueryCursor = { value: string | null; id: NodeId };

export type NodeQuery = {
  types?: NodeType[];
  where?: AttrCondition[];
  /**
   * Only nodes this user created — `props.birthtime.uid`, the one ownership
   * fact that never changes hands. A node column like `type`, not an attr, so
   * it cannot be an `AttrCondition`; both stores apply it as a plain equality
   * beside the type filter.
   */
  birthUid?: UserId;
  /**
   * Only the nodes in the tree under this path: its children, and the children of every node
   * below it that is neither a file nor a softlink. A file's own children (its metadata,
   * renditions, a sidecar) are within that file alone, not the directories above it, and a
   * softlink is a member but is not followed.
   * Resolved with the caller's access, which needs read and execute on the root, as listing it
   * does. Only the store holding the root answers: what is mounted inside the tree is not within.
   */
  within?: NodePath;
  /**
   * Leave out every node within any of these paths, by the same rule. Resolved with
   * administrative access, since it can only remove rows; a path that does not exist is ignored.
   */
  notWithin?: NodePath[];
  /**
   * Ordering attribute. Rows whose ordering attr is absent are **excluded** —
   * ordering by `takenAt` only means anything for nodes that have one, and it
   * keeps keyset paging free of null-ordering edge cases.
   *
   * Omit to order by node id ascending.
   */
  orderBy?: NodeQueryOrder;
  after?: NodeQueryCursor;
  limit: number;
};

/**
 * A query hit.
 *
 * NOTE: `node.props.count` is always 0 — the query path deliberately skips the
 * link-count join. Call `getNode` if you need it.
 */
export type NodeQueryRow<T extends NodeAttrs = NodeAttrs> = {
  node: Node<T>;
  /** Projection of `orderBy`, or null when the query was unordered. */
  sortValue: string | null;
};

/** A query hit resolved to a path by the VFS layer. */
export type NodeQueryEntry<T extends NodeAttrs = NodeAttrs> = {
  id: NodeId;
  /** Absolute path, including any mount prefix. */
  absPath: string;
  node: Node<T>;
  sortValue: string | null;
};

/**
 * A softlink found by its target — the reverse of following one.
 *
 * `parentId` is the directory the link sits in, which for a link kept under
 * the node it describes is the node the caller wants.
 */
export type LinkEntry = {
  /** The softlink node's own id. */
  id: NodeId;
  /** Absolute path of the link itself, including any mount prefix. */
  absPath: string;
  parentId: NodeId;
  /** The path the link points at. */
  target: string;
  node: Node;
};

/** Node columns an aggregate may group on, as opposed to an attr projection. */
type NodeColumn = 'type' | 'birthtime' | 'id';

/** Bucket a timestamp column. Only meaningful for `birthtime`. */
export type NodeColumnTruncate = 'year' | 'month';

type NodeAggregateGroup =
  /**
   * `prefixLength: 4` on an ISO timestamp buckets by year.
   *
   * `each` reads an array attr element by element: a node counts once under each distinct
   * element (`labels: ['a', 'b']` is one in `a` and one in `b`), and a value that is not an
   * array counts under itself. `prefixLength` then applies to each element.
   */
  | { ref: AttrRef; prefixLength?: number; each?: boolean }
  /**
   * Group on a node column rather than an attr projection. Neither node type
   * nor birthtime has a counterpart in the attrs JSONB, so this is the only way
   * to count nodes per type, or per the year they entered the archive.
   *
   * `truncate` is what makes birthtime useful: ungrouped it is one bucket per
   * millisecond. It is rejected for `type` and `id`, which are not timestamps.
   *
   * `id` is one bucket per node: the ids of every match, with any attr groups
   * beside it, without reading a node or resolving a path. Like every bucket it
   * counts only what the caller may reach, but the ids are still for a caller
   * to read through `getNodesByIds`, never to show as they are.
   */
  | { column: NodeColumn; truncate?: NodeColumnTruncate };

export type NodeAggregateQuery = {
  types?: NodeType[];
  where?: AttrCondition[];
  /**
   * Count only these nodes: for a caller that already holds a batch of ids — the files above a
   * map's positions — and wants to know which of them match, without reading each node.
   */
  ids?: NodeId[];
  /** Same filter as `NodeQuery.birthUid`, so a count can answer "how much of this is mine". */
  birthUid?: UserId;
  /** Count only the nodes within this path; see `NodeQuery.within`. */
  within?: NodePath;
  /** Leave out the nodes within these paths; see `NodeQuery.notWithin`. */
  notWithin?: NodePath[];
  /**
   * Ordered group dimensions. A node must have a value for every attr
   * dimension to contribute; node-column dimensions are always present. An
   * `each` dimension puts a node in as many buckets as its array has distinct
   * elements, so bucket counts then need not sum to the nodes matched.
   */
  group: [NodeAggregateGroup, ...NodeAggregateGroup[]];
  /**
   * Also total this attr per bucket, as `AggregateBucket.sum`.
   *
   * Rows where the attr is absent or not a JSON number are skipped by the sum
   * but still counted, so `count` never silently changes meaning because a
   * value was missing. Summing bytes over a group is the case this exists for —
   * "how much did the library grow that year" is not answerable by counting
   * files, since a year of video and a year of phone snaps are not comparable.
   */
  sum?: AttrRef;
  /**
   * Also count, per bucket, the rows meeting each named list of conditions, as
   * `AggregateBucket.counts` under the same names: several filtered counts in the one pass that
   * counts the bucket. A name is letters, digits and `_`.
   */
  counts?: Record<string, AttrCondition[]>;
  /** Only the buckets counting at least this many rows. */
  minCount?: number;
};

/** Narrow a group to its node-column form. */
export const isColumnGroup = (group: NodeAggregateGroup): group is { column: NodeColumn; truncate?: NodeColumnTruncate } => 'column' in group;

/** Validate grouping options before either store starts evaluating rows. */
export const validateAggregateGroup = (group: NodeAggregateGroup): void => {
  if (isColumnGroup(group)) {
    if (group.column === 'birthtime' && group.truncate === undefined) {
      throw new Error('grouping on birthtime requires a truncate (year or month)');
    }
    if (group.column !== 'birthtime' && group.truncate !== undefined) {
      throw new Error(`cannot truncate the ${group.column} column: it is not a timestamp`);
    }
    return;
  }

  if (group.prefixLength !== undefined) {
    const length = group.prefixLength;
    if (!Number.isInteger(length) || length < 1 || length > 64) {
      throw new Error(`invalid group prefix length: ${length}`);
    }
  }
};

/**
 * Validate what an aggregate asks beside its groups: the names of its `counts` and their
 * conditions' refs, and `minCount`.
 */
export const validateAggregateExtras = (query: Pick<NodeAggregateQuery, 'counts' | 'minCount'>): void => {
  for (const [name, conditions] of Object.entries(query.counts ?? {})) {
    if (!VALID_ATTR_NAME.test(name)) throw new Error(`invalid count name: ${name}`);
    for (const condition of conditions) assertValidAttrRef(condition.ref);
  }
  if (query.minCount !== undefined && (!Number.isInteger(query.minCount) || query.minCount < 1)) {
    throw new Error(`invalid minimum count: ${query.minCount}`);
  }
};

/** PostgreSQL and in-memory stores both order bucket tuples lexicographically. */
export const compareAggregateKeys = (a: readonly string[], b: readonly string[]): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

export type AggregateBucket = {
  /** Values corresponding positionally to `NodeAggregateQuery.group`. */
  key: [string, ...string[]];
  count: number;
  /** Present only when the query asked for a sum. Zero when no row contributed. */
  sum?: number;
  /** Present only when the query asked for `counts`: each named count, zero when no row met it. */
  counts?: Record<string, number>;
};

/**
 * One place a node is reachable from.
 *
 * `parentId` comes free from the hierarchy walk and saves a lookup for callers
 * that hold a child id but want its parent — e.g. a media file's GPS child,
 * where the parent *is* the file.
 */
export type ResolvedPath = {
  path: string;
  parentId: NodeId;
};

/**
 * One hierarchy edge pointing at a node: its parent, and the name it hangs
 * under. What is left of `ResolvedPath` once nobody needs the path — enough to
 * tell what kind of node a child hangs under without building a path.
 */
export type ParentLink = {
  parentId: NodeId;
  name: string;
};

/** The attr paths a ref reads, in precedence order. */
export const attrRefPaths = (ref: AttrRef): string[][] => {
  const refs = typeof ref === 'string' || 'path' in ref ? [ref] : ref.coalesce;
  return refs.map((candidate) => typeof candidate === 'string' ? [candidate] : candidate.path);
};

/** An attr named as a dotted path, as a ref: `duplicate.deferred` is the `deferred` key of `duplicate`. */
export const attrRefOf = (name: string): AttrPathRef => name.includes('.') ? { path: name.split('.') } : name;

const VALID_ATTR_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Attr names reach the SQL builder as an interpolated JSONB path, so they are
 * validated rather than parameterized. Values always are parameterized.
 */
export const assertValidAttrRef = (ref: AttrRef): void => {
  const paths = attrRefPaths(ref);
  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    throw new Error('attribute ref must name at least one attribute');
  }
  for (const path of paths) {
    for (const segment of path) {
      if (typeof segment !== 'string' || !VALID_ATTR_NAME.test(segment)) {
        throw new Error(`invalid attribute name: ${segment}`);
      }
    }
  }
};

/**
 * Smallest string greater than every string starting with `prefix`, so a
 * prefix match becomes a half-open range an index can scan.
 *
 * Byte-oriented, which is why comparisons run under `COLLATE "C"`.
 * Returns undefined for an empty prefix (no upper bound).
 */
export const prefixUpperBound = (prefix: string): string | undefined => {
  if (prefix === '') return undefined;
  const head = prefix.slice(0, -1);
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${head}${String.fromCharCode(last + 1)}`;
};
