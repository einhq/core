/**
 * NodeQuery → parameterized SQL.
 *
 * This path carries user input from the search box, so every value is bound as
 * `$n`. Attribute *names* are validated against a strict charset instead, since
 * they form a JSONB path that cannot be parameterized.
 *
 * Text projections are compared under `COLLATE "C"` so ranges are byte-ordered;
 * an order in a language's collation sorts under ICU's for that language
 * (`"sv-x-icu"`) instead, its cursor too. The DDL in `createSchema` must use the identical expression or the
 * planner won't match the index.
 */

import { type Access, linkLive } from '../../lib/access/mod.ts';
import type { NodeId } from '../../vfs/node.ts';
import type { StoreAggregateQuery, StoreNodeQuery, StoreScope } from '../../vfs/node-store.ts';
import {
  assertValidAttrRef,
  type AttrCondition,
  type AttrRef,
  attrRefPaths,
  isColumnGroup,
  MATCH_EXTENSION,
  type NodeQueryCollation,
  prefixUpperBound,
  validateAggregateExtras,
  validateAggregateGroup,
} from '../../vfs/query.ts';

export type SqlQuery = { text: string; values: unknown[] };

/** Cycle guard for the recursive walks over the hierarchy; real trees are nowhere near this. */
export const MAX_PATH_DEPTH = 64;

/**
 * The attr an index per language holds each node type's rows in order of
 * (`<attrs>_type_name_sorted_<language>_idx`, over the attrs table's `node_type`): the name, as
 * search sorts names.
 */
export const TYPED_ORDER_REF: AttrRef = 'name';

/** The tables a statement over a subtree walks besides the attrs. */
export type TreeTables = { nodes: string; hierarchy: string };

/**
 * Text projection of an attr ref. Shared by the query builder and the DDL, so
 * the index expression and the query expression are textually identical.
 *
 * `column` defaults to the unqualified name used in index definitions;
 * PostgreSQL normalizes the alias away, so `a.attributes` and `attributes`
 * produce the same stored expression.
 */
export const attrTextExpr = (ref: AttrRef, column = 'attributes'): string => {
  assertValidAttrRef(ref);
  const projections = attrRefPaths(ref).map((path) => {
    const parent = path.slice(0, -1).reduce((expr, segment) => `${expr}->'${segment}'`, column);
    return `${parent}->>'${path[path.length - 1]}'`;
  });
  return projections.length === 1 ? projections[0] : `COALESCE(${projections.join(', ')})`;
};

/** JSON projection used where the value's JSON type matters (aggregate sums). */
const attrJsonExpr = (ref: AttrRef, column: string): string => {
  assertValidAttrRef(ref);
  const projections = attrRefPaths(ref).map((path) => {
    const expr = path.reduce((parent, segment) => `${parent}->'${segment}'`, column);
    // JSON null is a value to `COALESCE`, but AttrRef treats it as absent.
    return `NULLIF(${expr}, 'null'::jsonb)`;
  });
  return projections.length === 1 ? projections[0] : `COALESCE(${projections.join(', ')})`;
};

/** PostgreSQL's collation for each of `NodeQueryCollation`'s; ICU's, as the memory store's `Intl.Collator` is. */
const SQL_COLLATIONS: Record<NodeQueryCollation, string> = { bytes: 'C', en: 'en-x-icu', sv: 'sv-x-icu' };

/** The same projection, collated for ordering and range comparisons. */
export const attrSortExpr = (ref: AttrRef, column = 'attributes', collation: NodeQueryCollation = 'bytes'): string =>
  `(${attrTextExpr(ref, column)}) COLLATE "${SQL_COLLATIONS[collation]}"`;

/**
 * `MatchRank` of the projection against a bound text: the same ladder as `matchRank`, with
 * `MATCH_EXTENSION`'s pattern. `lower()` folds case as ILIKE does.
 */
const matchRankExpr = (expr: string, match: string, params: ParamList): string => {
  const folded = `lower(${expr})`;
  const wanted = params.bind(match.toLowerCase());
  return `CASE WHEN ${folded} = ${wanted} OR regexp_replace(${folded}, '${MATCH_EXTENSION.source}', '') = ${wanted} THEN '0'` +
    ` WHEN ${folded} LIKE ${params.bind(`${escapeLike(match.toLowerCase())}%`)} THEN '1'` +
    ` WHEN strpos(${folded}, ${wanted}) > 0 THEN '2' ELSE '3' END COLLATE "C"`;
};

/**
 * A `contains` value is a string to find, not a pattern to match, so LIKE's
 * metacharacters are escaped into literals. The escape character is LIKE's
 * default backslash, which needs escaping first.
 */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export class ParamList {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const conditionSql = (cond: AttrCondition, params: ParamList, column: string): string => {
  const expr = attrTextExpr(cond.ref, column);
  const sortExpr = attrSortExpr(cond.ref, column);

  switch (cond.op) {
    case 'exists':
      return `(${expr}) IS NOT NULL`;
    case 'missing':
      return `(${expr}) IS NULL`;
    case 'eq':
      return `${sortExpr} = ${params.bind(String(cond.value))}`;
    case 'ne':
      // Missing must count as "not equal" (see query-eval.ts), so the NULL is
      // coalesced away rather than propagating through the comparison.
      return `COALESCE(${expr}, '') COLLATE "C" <> ${params.bind(String(cond.value))}`;
    case 'gte':
      return `${sortExpr} >= ${params.bind(String(cond.value))}`;
    case 'gt':
      return `${sortExpr} > ${params.bind(String(cond.value))}`;
    case 'lte':
      return `${sortExpr} <= ${params.bind(String(cond.value))}`;
    case 'lt':
      return `${sortExpr} < ${params.bind(String(cond.value))}`;
    case 'prefix': {
      const upper = prefixUpperBound(cond.value);
      const lower = `${sortExpr} >= ${params.bind(cond.value)}`;
      return upper === undefined ? lower : `${lower} AND ${sortExpr} < ${params.bind(upper)}`;
    }
    case 'contains':
      // `expr`, not `sortExpr`: ILIKE has no use for a byte collation, and the
      // trigram index is built on the uncollated projection — the two
      // expressions must be textually identical or the planner will not match
      // them and every name search falls back to a sequential scan.
      return `(${expr}) ILIKE ${params.bind(`%${escapeLike(cond.value)}%`)}`;
    case 'in':
      return `${sortExpr} = ANY(${params.bind(cond.value.map(String))})`;
  }
};

/**
 * The recursive walk from `roots` down through every node that is neither a file nor a softlink:
 * the nodes whose children are within the roots (`NodeQuery.within`). The roots are at depth 0.
 */
const treeCte = (name: string, roots: string, tables: TreeTables): string => `
  ${name}(id, depth) AS (
    SELECT unnest(${roots}::varchar[]), 0
    UNION ALL
    SELECT h.child_id, t.depth + 1
    FROM ${name} t
    JOIN ${tables.hierarchy} h ON h.parent_id = t.id
    JOIN ${tables.nodes} c ON c.id = h.child_id
    WHERE c.type <> 'file' AND c.softlink IS NULL AND t.depth < ${MAX_PATH_DEPTH}
  )`;

/** `name`: the distinct nodes within `roots`, materialized once for the statement that joins it. */
const membersCte = (name: string, roots: string, tables: TreeTables): string => `
  ${treeCte(`${name}_tree`, roots, tables)},
  ${name} AS MATERIALIZED (
    SELECT DISTINCT h.child_id AS id FROM ${name}_tree t JOIN ${tables.hierarchy} h ON h.parent_id = t.id
  )`;

/**
 * What a scope adds to a statement over `attrs a`: the CTEs, the relation to read the attrs rows
 * from — the members joined to the attrs for `withinId` — and an anti-join for `notWithinIds`.
 *
 * The anti-join asks the hierarchy whether a row hangs under one of the excluded trees' nodes,
 * which an init plan collects into an array once. A CTE scan cannot run in a parallel worker, so
 * joining the excluded members themselves would make an aggregate over the whole table serial;
 * the array is handed to the workers, each of which hashes the edges under it off an index led by
 * `parent_id`.
 */
const scopeSql = (scope: StoreScope, params: ParamList, attrsTable: string, tables: TreeTables | undefined) => {
  const ctes: string[] = [];
  const clauses: string[] = [];
  let from = `${attrsTable} a`;
  const scoped = scope.withinId !== undefined || (scope.notWithinIds?.length ?? 0) > 0;
  if (scoped && !tables) throw new Error('a scoped query needs the hierarchy tables');
  if (scope.withinId !== undefined) {
    ctes.push(membersCte('within_members', params.bind([scope.withinId]), tables!));
    from = `within_members m JOIN ${attrsTable} a ON a.node_id = m.id`;
  }
  if (scope.notWithinIds?.length) {
    ctes.push(treeCte('excluded_tree', params.bind(scope.notWithinIds), tables!));
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM ${tables!.hierarchy} x WHERE x.child_id = a.node_id AND x.parent_id = ANY(ARRAY(SELECT id FROM excluded_tree)))`,
    );
  }
  return { with: ctes.length > 0 ? `WITH RECURSIVE ${ctes.join(',')}` : '', from, clauses };
};

/**
 * Whether the node row `row` grants `reader` read, as `verifyAccess` decides it: owner, group and
 * other bits, then the access list. A share link's own entries stop granting once it has expired.
 *
 * The access list is asked with one jsonpath test rather than a subquery over its elements: a
 * correlated subquery keeps an aggregate over the whole table from running in parallel workers.
 */
export const readsSql = (row: string, reader: Access, params: ParamList): string => {
  const uid = params.bind(reader.uid);
  const gids = params.bind(reader.gids);
  const named = [
    ...(reader.link === undefined || linkLive(reader) ? [`@.uid == ${Math.trunc(reader.uid)}`] : []),
    ...reader.gids.map((gid) => `@.gid == ${Math.trunc(gid)}`),
  ];
  const acl = named.length === 0 ? '' : `
      OR ${row}.acl @? ${params.bind(`$[*] ? ((${named.join(' || ')}) && (@.mode == 4 || @.mode == 5 || @.mode == 6 || @.mode == 7))`)}::jsonpath`;
  return `(
      (${row}.uid = ${uid} AND ${row}.mode & 256 <> 0)
      OR (${row}.gid = ANY(${gids}::int[]) AND ${row}.mode & 32 <> 0)
      OR ${row}.mode & 4 <> 0${acl})`;
};

/** `typed`: the one type of `types` is matched on the attrs row's own `node_type`. */
const whereClauses = (
  query: { types?: string[]; where?: AttrCondition[]; birthUid?: number },
  params: ParamList,
  column: string,
  typed = false,
): string[] => {
  const clauses: string[] = [];
  if (typed) {
    clauses.push(`a.node_type = ${params.bind(query.types![0])}`);
  } else if (query.types && query.types.length > 0) {
    clauses.push(`n.type = ANY(${params.bind(query.types)})`);
  }
  if (query.birthUid !== undefined) {
    clauses.push(`n.birth_uid = ${params.bind(query.birthUid)}`);
  }
  for (const cond of query.where ?? []) {
    clauses.push(conditionSql(cond, params, column));
  }
  return clauses;
};

/** The columns a query row is read from, `sort_value` last. */
const rowColumns = (sortExpr: string): string => `
      n.id, n.type, n.mode, n.uid, n.gid, n.acl, n.softlink, n.tier,
      n.birth_uid, n.change_uid, n.mod_uid,
      extract(epoch FROM n.birth_time) * 1000 AS birth_time,
      extract(epoch FROM n.change_time) * 1000 AS change_time,
      extract(epoch FROM n.mod_time) * 1000 AS mod_time,
      a.attributes,
      ${sortExpr} AS sort_value`;

/** The rows `reader` may read and reach: reach one of `admitted`, the classes admitting it. */
const readerClauses = (reader: Access | undefined, admitted: number[] | undefined, params: ParamList): string[] => {
  if (reader === undefined) return [];
  if (admitted === undefined) throw new Error('a query for a reader needs the classes admitting it');
  // A bound array, which the planner hashes once.
  return [`n.reach = ANY(${params.bind(admitted)}::int[])`, readsSql('n', reader, params)];
};

/**
 * No link-count join, unlike `getNodeQuery`: a query row's `count` is 0. A scope reads the
 * members of `withinId` materialized (plan P1, see `PgStore.queryNodes`) and leaves out those of
 * `notWithinIds`; it needs the `hierarchy` table. A `reader` keeps the rows whose reach is one of
 * `admitted` and that it may read.
 *
 * One type ordered by `TYPED_ORDER_REF` in a language is matched on `a.node_type`, with `=`: the
 * language's index over the type and the name then holds the rows in the order asked for, which it
 * does not for `= ANY`.
 *
 * An unscoped query in id order with an `in` on an attr that leads an index (`indexed`) is read
 * value by value: a lateral `=` lookup per value, each taking at most `limit` rows in id order,
 * then the first `limit` of them all. Its plan is an index lookup per value however many values
 * there are, where `= ANY` over a long list may be planned as a walk of the whole table.
 */
export const buildQuerySql = (
  query: StoreNodeQuery,
  nodesTable: string,
  attrsTable: string,
  hierarchyTable?: string,
  indexed?: (ref: AttrRef) => boolean,
  admitted?: number[],
): SqlQuery => {
  const params = new ParamList();
  const column = 'a.attributes';
  const unscoped = query.withinId === undefined && !query.notWithinIds?.length;
  const each = !query.orderBy && unscoped && indexed ? (query.where ?? []).findIndex((cond) => cond.op === 'in' && indexed(cond.ref)) : -1;
  if (each >= 0) return buildEachSql(query, each, nodesTable, attrsTable, admitted);
  const typed = query.types?.length === 1 && query.orderBy !== undefined && query.orderBy.match === undefined &&
    (query.orderBy.collation ?? 'bytes') !== 'bytes' &&
    attrTextExpr(query.orderBy.ref, column) === attrTextExpr(TYPED_ORDER_REF, column);
  const clauses = whereClauses(query, params, column, typed);
  const scope = scopeSql(query, params, attrsTable, hierarchyTable === undefined ? undefined : { nodes: nodesTable, hierarchy: hierarchyTable });
  clauses.push(...scope.clauses, ...readerClauses(query.reader, admitted, params));

  const sortExpr = !query.orderBy
    ? null
    : query.orderBy.match !== undefined
    ? matchRankExpr(attrTextExpr(query.orderBy.ref, column), query.orderBy.match, params)
    : attrSortExpr(query.orderBy.ref, column, query.orderBy.collation);
  const dir = query.orderBy?.dir ?? 'asc';
  const cmp = dir === 'desc' ? '<' : '>';

  if (sortExpr) {
    // Rows without the ordering attr are excluded, matching runQuery(). A
    // range on that same attr already says so — NULL compares as neither — and
    // spelling it twice costs more than words: the planner treats the two as
    // independent and multiplies their selectivities, under-counting a seek by
    // the attr's null fraction all over again.
    const ranged = (query.where ?? []).some((cond) =>
      JSON.stringify(cond.ref) === JSON.stringify(query.orderBy!.ref) && ['gte', 'gt', 'lte', 'lt', 'eq', 'prefix', 'in'].includes(cond.op)
    );
    if (!ranged) clauses.push(`(${attrTextExpr(query.orderBy!.ref, column)}) IS NOT NULL`);
  }

  // The cursor names `a.node_id`, not `n.id`: the join makes them equal, but PostgreSQL carries
  // only equalities across a join, so a bound on `n.id` reaches an attrs index scan as a filter
  // and every page reads the walk from its start again.
  if (query.after) {
    if (sortExpr) {
      clauses.push(`(${sortExpr}, a.node_id) ${cmp} (${params.bind(query.after.value ?? '')}, ${params.bind(query.after.id)})`);
    } else {
      clauses.push(`a.node_id ${cmp} ${params.bind(query.after.id)}`);
    }
  }

  const orderBy = sortExpr ? `${sortExpr} ${dir.toUpperCase()}, n.id ${dir.toUpperCase()}` : `n.id ${dir.toUpperCase()}`;

  const text = `
    ${scope.with}
    SELECT ${rowColumns(sortExpr ?? 'NULL')}
    FROM ${scope.from}
    JOIN ${nodesTable} n ON n.id = a.node_id
    ${clauses.length > 0 ? `WHERE ${clauses.join('\n      AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ${params.bind(query.limit)}
  `;

  return { text, values: params.values };
};

/** `buildQuerySql`'s value-by-value read of the condition `each` (an `in`), for an unscoped query in id order. */
const buildEachSql = (query: StoreNodeQuery, each: number, nodesTable: string, attrsTable: string, admitted?: number[]): SqlQuery => {
  const params = new ParamList();
  const column = 'a.attributes';
  const where = query.where ?? [];
  const cond = where[each] as Extract<AttrCondition, { op: 'in' }>;
  const values = params.bind([...new Set(cond.value.map(String))]);
  const clauses = whereClauses({ ...query, where: where.filter((_, i) => i !== each) }, params, column);
  clauses.push(`${attrSortExpr(cond.ref, column)} = k.v`, ...readerClauses(query.reader, admitted, params));
  if (query.after) clauses.push(`a.node_id > ${params.bind(query.after.id)}`);
  const limit = params.bind(query.limit);
  const text = `
    SELECT x.* FROM unnest(${values}::text[]) AS k(v)
    CROSS JOIN LATERAL (
      SELECT ${rowColumns('NULL')}
      FROM ${attrsTable} a
      JOIN ${nodesTable} n ON n.id = a.node_id
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY a.node_id ASC
      LIMIT ${limit}
    ) x
    ORDER BY x.id ASC
    LIMIT ${limit}
  `;
  return { text, values: params.values };
};

/**
 * One `GROUP BY` over the attrs (an `each` group a lateral join over the array's elements), with a `FILTER`ed count per entry of `counts` (`c_<i>`, in their
 * order) and `minCount` as a `HAVING`. A scope reads only the members of `withinId` and leaves out
 * those of `notWithinIds`; it needs the `hierarchy` table. A `reader` counts the rows whose reach
 * is one of `admitted`, the classes admitting it, and that it may read.
 */
export const buildAggregateSql = (
  query: StoreAggregateQuery,
  nodesTable: string,
  attrsTable: string,
  hierarchyTable?: string,
  admitted?: number[],
): SqlQuery => {
  const params = new ParamList();
  const column = 'a.attributes';
  const clauses = whereClauses(query, params, column);
  if (query.ids !== undefined) clauses.push(`a.node_id = ANY(${params.bind([...new Set(query.ids)])})`);
  validateAggregateExtras(query);
  const tables = hierarchyTable === undefined ? undefined : { nodes: nodesTable, hierarchy: hierarchyTable };
  const scope = scopeSql(query, params, attrsTable, tables);
  clauses.push(...scope.clauses);
  const withSql = scope.with;
  clauses.push(...readerClauses(query.reader, admitted, params));

  // `n` is only referenced by the type filter, and PostgreSQL cannot elide an
  // inner join on a FK — so joining unconditionally would make every types-less
  // aggregate pay for a join it never reads. buildQuerySql always needs the
  // join, for the node columns it selects.
  let needsNodes = (query.types?.length ?? 0) > 0 || query.birthUid !== undefined || query.reader !== undefined;
  if (query.group.length === 0) throw new Error('aggregate requires at least one group');
  query.group.forEach(validateAggregateGroup);

  const laterals: string[] = [];
  const groupExprs = query.group.map((group) => {
    if (isColumnGroup(group)) {
      // The attrs row carries the id, so only `type` and `birthtime` need the
      // join. Both are NOT NULL, as `id` is, and every node has an attrs row,
      // so the count needs no null guard.
      if (group.column === 'id') return 'a.node_id';
      needsNodes = true;

      if (group.column === 'birthtime') {
        return `to_char(n.birth_time, '${group.truncate === 'year' ? 'YYYY' : 'YYYY-MM'}')`;
      }
      return `n.${group.column}`;
    }

    // Interpolated rather than bound: LEFT()'s length argument needs a resolved
    // integer type, and this is a validated number, not user text.
    const cut = (expr: string) => group.prefixLength === undefined ? expr : `LEFT(${expr}, ${group.prefixLength})`;

    if (group.each) {
      // One row per distinct element; a node whose attr is absent, or an empty array, has none and
      // drops out like a missing value does. A scalar is read as a one-element array.
      const json = attrJsonExpr(group.ref, column);
      const alias = `e_${laterals.length}`;
      laterals.push(
        `CROSS JOIN LATERAL (SELECT DISTINCT ${cut('value')} AS value FROM jsonb_array_elements_text(` +
          `CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ELSE jsonb_build_array(${json}) END) WHERE value IS NOT NULL) ${alias}`,
      );
      return `${alias}.value`;
    }

    const expr = attrTextExpr(group.ref, column);
    clauses.push(`(${expr}) IS NOT NULL`);
    return cut(expr);
  });

  // Guarded by jsonb_typeof rather than cast-and-hope: `->>` yields text, and a
  // non-numeric value there aborts the whole aggregate rather than skipping the
  // row. Rows that fail the guard still count, they just add nothing.
  let sumExpr = '';
  if (query.sum !== undefined) {
    const jsonExpr = attrJsonExpr(query.sum, column);
    const textExpr = attrTextExpr(query.sum, column);
    const numeric = `CASE WHEN jsonb_typeof(${jsonExpr}) = 'number' THEN (${textExpr})::numeric END`;
    sumExpr = `, COALESCE(SUM(${numeric}), 0) AS sum`;
  }

  const countExprs = Object.values(query.counts ?? {}).map((conditions, i) => {
    const filter = conditions.map((cond) => conditionSql(cond, params, column));
    return `, COUNT(*) FILTER (WHERE ${filter.length > 0 ? filter.join(' AND ') : 'true'}) AS c_${i}`;
  }).join('');
  const having = query.minCount !== undefined ? `HAVING COUNT(*) >= ${params.bind(query.minCount)}` : '';

  const text = `
    ${withSql}
    SELECT ${groupExprs.map((expr, i) => `${expr} AS key_${i}`).join(', ')}, COUNT(*) AS count${sumExpr}${countExprs}
    FROM ${scope.from}
    ${needsNodes ? `JOIN ${nodesTable} n ON n.id = a.node_id` : ''}
    ${laterals.join('\n    ')}
    ${clauses.length > 0 ? `WHERE ${clauses.join('\n      AND ')}` : ''}
    GROUP BY ${groupExprs.map((_, i) => i + 1).join(', ')}
    ${having}
    ORDER BY ${groupExprs.map((_, i) => i + 1).join(', ')}
  `;

  return { text, values: params.values };
};

/**
 * How many nodes are within `rootId`, up to `cap`: the member edges of the tree, read lazily, so
 * the walk stops after `cap` of them. A node linked twice within counts twice.
 */
export const buildScopeSizeSql = (rootId: NodeId, cap: number, tables: TreeTables): SqlQuery => ({
  text: `
    WITH RECURSIVE ${treeCte('tree', '$1', tables)}
    SELECT count(*) AS size
    FROM (SELECT 1 FROM tree t JOIN ${tables.hierarchy} h ON h.parent_id = t.id LIMIT $2) members
  `,
  values: [[rootId], cap],
});

/**
 * Which of `roots` each of `ids` lies within: one recursive walk up the hierarchy from the parents
 * of the ids, through nodes that are neither files nor softlinks, ending at any of `stops`. A
 * file's own child stops at its file and reaches no root; a node linked in two places reaches what
 * either path reaches. A root the walk passes on its way to a stop is recorded too. Rows are
 * `(origin, at)`: `at` a root that `origin` is within.
 *
 * The walk starts once per distinct parent rather than once per id: a batch read in time order is
 * mostly a few albums' pictures, which share every ancestor.
 */
export const buildUpwalkSql = (ids: NodeId[], roots: NodeId[], stops: NodeId[], tables: TreeTables): SqlQuery => ({
  text: `
    WITH RECURSIVE parent AS MATERIALIZED (
      SELECT h.child_id AS origin, h.parent_id AS at FROM ${tables.hierarchy} h WHERE h.child_id = ANY($1)
    ),
    up(start, at, depth) AS (
      SELECT DISTINCT at, at, 1 FROM parent
      UNION ALL
      SELECT up.start, h.parent_id, up.depth + 1
      FROM up
      JOIN ${tables.nodes} p ON p.id = up.at
      JOIN ${tables.hierarchy} h ON h.child_id = up.at
      WHERE up.at <> ALL($3) AND p.type <> 'file' AND p.softlink IS NULL AND up.depth < ${MAX_PATH_DEPTH}
    )
    SELECT DISTINCT parent.origin, up.at FROM parent JOIN up ON up.start = parent.at WHERE up.at = ANY($2)
  `,
  values: [ids, roots, stops],
});
