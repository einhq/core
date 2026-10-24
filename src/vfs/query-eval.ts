/**
 * In-memory evaluation of NodeQuery conditions.
 *
 * This is the reference semantics: the PostgreSQL store's SQL builder must
 * agree with it, and the shared conformance suite runs the same cases against
 * both.
 */

import type { Node, NodeAttrs } from './node.ts';
import {
  type AggregateBucket,
  assertValidAttrRef,
  type AttrCondition,
  type AttrRef,
  attrRefPaths,
  compareAggregateKeys,
  compareText,
  isColumnGroup,
  matchRank,
  type NodeAggregateQuery,
  type NodeColumnTruncate,
  type NodeQuery,
  type NodeQueryCollation,
  type NodeQueryRow,
  prefixUpperBound,
  validateAggregateExtras,
  validateAggregateGroup,
} from './query.ts';

/** Read the first present, non-null value named by a ref. */
const projectAttrValue = (attrs: NodeAttrs, ref: AttrRef): unknown => {
  assertValidAttrRef(ref);

  for (const path of attrRefPaths(ref)) {
    let value: unknown = attrs;
    for (const segment of path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

/**
 * Project an attr to the text form comparisons operate on.
 * Mirrors PostgreSQL's `->>`: absent/null → undefined, objects → JSON.
 */
const projectAttrText = (attrs: NodeAttrs, ref: AttrRef): string | undefined => {
  const value = projectAttrValue(attrs, ref);
  if (value === undefined) return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

/**
 * An attr's elements in text form, for an `each` group: an array's non-null elements, or the value
 * itself when it is not an array. Mirrors PostgreSQL's `jsonb_array_elements_text`.
 */
const projectAttrElements = (attrs: NodeAttrs, ref: AttrRef): string[] => {
  const value = projectAttrValue(attrs, ref);
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((element) => element !== null && element !== undefined)
    .map((element) => typeof element === 'object' ? JSON.stringify(element) : String(element));
};

/** Whether `attrs` meet `cond`, as a store's query would decide it. */
export const matchesCondition = (attrs: NodeAttrs, cond: AttrCondition): boolean => {
  const actual = projectAttrText(attrs, cond.ref);

  switch (cond.op) {
    case 'exists':
      return actual !== undefined;
    case 'missing':
      return actual === undefined;
    case 'eq':
      // Strict: missing never equals anything.
      return actual !== undefined && actual === String(cond.value);
    case 'ne':
      // Lenient: a missing attr counts as "not equal", so rows lacking the attr
      // are included without resorting to OR.
      return actual !== String(cond.value);
    case 'gte':
      return actual !== undefined && actual >= String(cond.value);
    case 'gt':
      return actual !== undefined && actual > String(cond.value);
    case 'lte':
      return actual !== undefined && actual <= String(cond.value);
    case 'lt':
      return actual !== undefined && actual < String(cond.value);
    case 'prefix': {
      if (actual === undefined) return false;
      const upper = prefixUpperBound(cond.value);
      return actual >= cond.value && (upper === undefined || actual < upper);
    }
    case 'contains': {
      if (actual === undefined) return false;
      // Case folded on both sides, matching the SQL side's ILIKE. Done with
      // includes() rather than a regexp so the value needs no escaping — a `%`
      // or a `.` in a filename is a character, not a pattern.
      return actual.toLowerCase().includes(cond.value.toLowerCase());
    }
    case 'in': {
      if (actual === undefined) return false;
      return cond.value.some((v) => String(v) === actual);
    }
  }
};

const matchesQuery = (node: Node, query: Omit<NodeQuery, 'within' | 'notWithin'>): boolean => {
  if (query.types && !query.types.includes(node.type)) return false;
  if (query.birthUid !== undefined && node.props.birthtime.uid !== query.birthUid) return false;
  for (const cond of query.where ?? []) {
    if (!matchesCondition(node.attrs, cond)) return false;
  }
  return true;
};

/**
 * Run a query over an arbitrary node collection. Used by the in-memory store;
 * also the model the SQL builder is checked against. The scope (`within`,
 * `notWithin`) is the caller's: `nodes` are the ones it admits.
 */
export const runQuery = <T extends NodeAttrs = NodeAttrs>(
  nodes: Iterable<Node>,
  query: Omit<NodeQuery, 'within' | 'notWithin'>,
): NodeQueryRow<T>[] => {
  const rows: NodeQueryRow<T>[] = [];

  for (const node of nodes) {
    if (!matchesQuery(node, query)) continue;

    let sortValue: string | null = null;
    if (query.orderBy) {
      const projected = projectAttrText(node.attrs, query.orderBy.ref);
      // Rows without the ordering attr are excluded, not sorted to an end.
      if (projected === undefined) continue;
      sortValue = query.orderBy.match === undefined ? projected : matchRank(projected, query.orderBy.match);
    }

    rows.push({ node: stripHierarchy(node) as Node<T>, sortValue });
  }

  const dir = query.orderBy?.dir ?? 'asc';
  const sign = dir === 'desc' ? -1 : 1;
  const collation = query.orderBy?.collation;
  rows.sort((a, b) => {
    if (a.sortValue !== b.sortValue) {
      return compareText(a.sortValue ?? '', b.sortValue ?? '', collation) * sign;
    }
    // Node id breaks ties so the cursor is total and paging can't loop.
    if (a.node.id === b.node.id) return 0;
    return (a.node.id < b.node.id ? -1 : 1) * sign;
  });

  const after = query.after;
  const start = after === undefined ? 0 : rows.findIndex((row) => afterCursor(row, after, sign, collation));
  if (after !== undefined && start === -1) return [];

  return rows.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + query.limit);
};

const afterCursor = (row: NodeQueryRow, after: { value: string | null; id: string }, sign: number, collation?: NodeQueryCollation): boolean => {
  const rowValue = row.sortValue ?? '';
  const cursorValue = after.value ?? '';
  if (rowValue !== cursorValue) {
    return compareText(rowValue, cursorValue, collation) * sign > 0;
  }
  if (row.node.id === after.id) return false;
  return (row.node.id < after.id ? -1 : 1) * sign > 0;
};

/**
 * The bucket a node's birthtime falls in.
 *
 * Rendered from the local date parts rather than the ISO string, so a node born
 * late on New Year's Eve lands in the year the archive's owner would say it did.
 * PostgreSQL's `to_char(birth_time, 'YYYY')` reads the column in the session
 * timezone and agrees.
 */
const birthtimeBucket = (node: Node, truncate: NodeColumnTruncate): string => {
  const date = new Date(node.props.birthtime.timestamp);
  const year = String(date.getFullYear()).padStart(4, '0');
  return truncate === 'year' ? year : `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Bucket-count matching nodes by one or more column or attr projections, with the named filtered
 * `counts` beside each count and the buckets below `minCount` left out. The scope (`within`,
 * `notWithin`) is the caller's: `nodes` are the ones it admits.
 */
export const runAggregate = (nodes: Iterable<Node>, query: Omit<NodeAggregateQuery, 'within' | 'notWithin'>): AggregateBucket[] => {
  if (query.group.length === 0) throw new Error('aggregate requires at least one group');
  query.group.forEach(validateAggregateGroup);
  validateAggregateExtras(query);
  const countNames = Object.keys(query.counts ?? {});
  const ids = query.ids === undefined ? undefined : new Set(query.ids);

  const buckets = new Map<string, AggregateBucket>();

  for (const node of nodes) {
    if (ids && !ids.has(node.id)) continue;
    if (query.types && !query.types.includes(node.type)) continue;
    if (query.birthUid !== undefined && node.props.birthtime.uid !== query.birthUid) continue;
    let matched = true;
    for (const cond of query.where ?? []) {
      if (!matchesCondition(node.attrs, cond)) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    // Each dimension's values for this node: one, or for an `each` group one per distinct element.
    const parts: string[][] = [];
    for (const group of query.group) {
      if (isColumnGroup(group)) {
        parts.push([group.column === 'birthtime' ? birthtimeBucket(node, group.truncate!) : node[group.column]]);
        continue;
      }
      const values = group.each ? projectAttrElements(node.attrs, group.ref) : [projectAttrText(node.attrs, group.ref)].filter((value) => value !== undefined);
      if (values.length === 0) break;
      parts.push([...new Set(group.prefixLength === undefined ? values : values.map((value) => value.slice(0, group.prefixLength)))]);
    }
    if (parts.length !== query.group.length) continue;

    const keys = parts.reduce<string[][]>((acc, values) => acc.flatMap((prefix) => values.map((value) => [...prefix, value])), [[]]);
    for (const key of keys) {
      const id = JSON.stringify(key);
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = {
          key: key as [string, ...string[]],
          count: 0,
          ...(query.sum !== undefined ? { sum: 0 } : {}),
          ...(query.counts !== undefined ? { counts: Object.fromEntries(countNames.map((name) => [name, 0])) } : {}),
        };
        buckets.set(id, bucket);
      }
      bucket.count++;
      for (const name of countNames) {
        if (query.counts![name].every((cond) => matchesCondition(node.attrs, cond))) bucket.counts![name]++;
      }

      if (query.sum !== undefined) {
        // Counted either way; only a real number contributes to the total, which
        // is what the SQL side's jsonb_typeof guard does.
        const value = projectAttrValue(node.attrs, query.sum);
        bucket.sum! += typeof value === 'number' && Number.isFinite(value) ? value : 0;
      }
    }
  }

  const minCount = query.minCount ?? 1;
  return [...buckets.values()].filter((bucket) => bucket.count >= minCount).sort((a, b) => compareAggregateKeys(a.key, b.key));
};

/**
 * Query rows never carry a link count — the PostgreSQL path skips the join that
 * would produce it, so the memory path must not expose it either.
 */
const stripHierarchy = (node: Node): Node => ({
  ...node,
  props: { ...node.props, count: 0 },
  attrs: { ...node.attrs },
});
