/**
 * PostgreSQL store. Its tables carry a name prefix, so several stores (and the PostgreSQL test
 * tier) can share one database.
 */

import { ulid } from '@std/ulid';
import type { Pool, PoolClient } from 'pg';
import type { FileTier } from '../../registries/file/types.ts';
import { type Access, ADMIN_GID, ADMIN_UID, type ReachFormula, reachNamed } from '../../lib/access/mod.ts';
import { GroupId, Mode, ModeACL, Ownership, UserId } from '../../lib/mode/mod.ts';
import {
  type AggregateBucket,
  type AuditQuery,
  type AuditRecord,
  type ChildLinkFilter,
  type EdgeMove,
  namedBy,
  type NewChild,
  type Node,
  NodeAlreadyExistsError,
  type NodeAttrs,
  type NodeAttrsUpdate,
  NodeChild,
  type NodeChildEntry,
  type NodeId,
  NodeNotFoundError,
  type NodePath,
  type NodePropsCreate,
  type NodePropsUpdate,
  type NodeQueryRow,
  type NodeStore,
  NodeStoreConfig,
  NodeTransactionError,
  type NodeType,
  type NodeUpdate,
  type OwnerRelease,
  type ParentLink,
  passesChanged,
  type PathEntry,
  type PathNode,
  prefixUpperBound,
  ReachClasses,
  type ReachGraph,
  type ReachRow,
  refreshReach,
  type ReleasedOwner,
  type ResolvedNodeChain,
  type StoreAggregateQuery,
  type StoredPath,
  type StoreNodeQuery,
  type StoreScope,
  type Transaction,
  type WriteDurability,
} from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { PathCache } from './path-cache.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import {
  attrSortExpr,
  attrTextExpr,
  buildAggregateSql,
  buildQuerySql,
  buildScopeSizeSql,
  buildUpwalkSql,
  MAX_PATH_DEPTH,
  ParamList,
  readsSql,
  type SqlQuery,
  type TreeTables,
  TYPED_ORDER_REF,
} from './query.ts';
import type { IndexDecl } from '../../lib/contributions/types.ts';
import { attrRefOf, NAME_LANGUAGES, type NodeQueryCollation, type NodeQueryOrder } from '../../vfs/query.ts';

/**
 * Core's own attr indexes, in the shape a module declares its own (`mod.json` `indexes`): names in
 * the order search sorts them by, one per language the archive can be in, the nodes whose
 * sharing is pinned, which `share info` lists, and the unlisted directories, which library views
 * leave out (`src/lib/search/unlisted.ts`).
 */
const CORE_ATTR_INDEXES: IndexDecl[] = [
  ...NAME_LANGUAGES.map((language): IndexDecl => ({ name: `name_sorted_${language}`, on: ['name'], partial: 'name', collation: language })),
  { name: 'access_pinned', on: ['accessPinned'], partial: 'accessPinned' },
  { name: 'unlisted', on: ['unlisted'], partial: 'unlisted' },
];

/** A name already taken under the parent — the `(parent_id, name)` primary key. */
const UNIQUE_VIOLATION = '23505';

/** The parent went away between resolving it and writing under it. */
const FOREIGN_KEY_VIOLATION = '23503';

/** A node row as the bulk reads give it, without the link-count join; `n` is the nodes table, `a` its attrs. */
const LINK_COLUMNS = `
  n.id, n.type, n.mode, n.uid, n.gid, n.acl, n.softlink, n.tier,
  n.birth_uid, n.change_uid, n.mod_uid,
  extract(epoch FROM n.birth_time) * 1000 AS birth_time,
  extract(epoch FROM n.change_time) * 1000 AS change_time,
  extract(epoch FROM n.mod_time) * 1000 AS mod_time,
  a.attributes`;

// ===== Types =====

/**
 * How `queryNodes` answers a query within a subtree (`withinId`).
 *
 * P1 materializes the subtree's members and reads their attrs rows; it is chosen when the subtree
 * holds at most `scopeThreshold` nodes, or when the order is one no index leads with. P2 reads the
 * query without its scope in index order, a batch at a time, and keeps the rows one walk up the
 * hierarchy places within it. Both answer the same rows, so the choice is cost alone:
 * `scopeThreshold` 0 forces P2 and `Infinity` P1.
 */
export type PgQueryPlanOptions = {
  /** Largest subtree, in member edges, read by P1. */
  scopeThreshold: number;
  /**
   * Largest P2 batch. Within a subtree a batch starts at twice the rows still wanted (at least
   * 64); leaving subtrees out of the whole store, at an eighth more than them. It doubles.
   */
  batchMax: number;
  /** How long a subtree's measured size is trusted, in milliseconds. */
  scopeCacheMs: number;
};

const DEFAULT_QUERY_PLAN: PgQueryPlanOptions = {
  // As many as a container listing or a complete layout reads.
  scopeThreshold: 20_000,
  batchMax: 1_000,
  scopeCacheMs: 60_000,
};

/** Subtree sizes remembered per store. */
const SCOPE_CACHE_ROOTS = 256;

/** Classes made between prunes, unless the config says otherwise. */
const REACH_PRUNE_AFTER = 256;

/** Smallest P2 batch within a subtree. */
const MIN_SCOPE_BATCH = 64;

/**
 * The attrs leading an index `createSchema` makes that any order by them can read — not partial on
 * another attr — so a P2 batch is read in index order. `createAttrIndexes` adds the declared ones.
 */
const ORDERED_INDEX_LEADERS = ['sha256', 'embeddingType'];

type PgStoreConfig = NodeStoreConfig & {
  pgPool: Pool;
  name: string; // Table name prefix: ${name}_nodes, ${name}_nodes_attr, ${name}_nodes_lnk, etc.
  queryPlan?: Partial<PgQueryPlanOptions>;
  /** Classes this store makes before it prunes them again; see `pruneWhenGrown`. */
  reachPruneAfter?: number;
};

// ===== PgTransaction Implementation =====

/** A transaction on a dedicated pooled connection, released on commit or rollback. */
class PgTransaction implements Transaction {
  readonly id: string;
  private _active = true;
  private ephemeralWrites = 0;
  private durableWrites = 0;
  private ended: (() => void)[] = [];

  constructor(public readonly client: PoolClient) {
    this.id = ulid();
  }

  get active(): boolean {
    return this._active;
  }

  declareWrite(durability: WriteDurability): void {
    if (durability === 'ephemeral') {
      this.ephemeralWrites++;
    } else {
      this.durableWrites++;
    }
  }

  /**
   * Run `fn` when the transaction ends, committed or rolled back. Both count, because a COMMIT that
   * fails may still have committed.
   */
  onEnd(fn: () => void): void {
    this.ended.push(fn);
  }

  async commit(): Promise<void> {
    if (!this._active) {
      throw new NodeTransactionError('Transaction already completed');
    }
    try {
      // `synchronous_commit = off` makes COMMIT return before the WAL is
      // flushed; the flush follows within wal_writer_delay, so the window in
      // which a crash loses the write is ~200 ms. Under load the flush is what
      // a session or tty write waits on, and a lost session node is exactly
      // what session-reap cleans up anyway. SET LOCAL and COMMIT go in one
      // simple query so this costs no extra round trip; SET LOCAL ends with the
      // transaction it is in.
      const relaxed = this.ephemeralWrites > 0 && this.durableWrites === 0;
      await this.client.query(relaxed ? 'SET LOCAL synchronous_commit TO OFF; COMMIT' : 'COMMIT');
    } finally {
      this._active = false;
      this.client.release();
      for (const fn of this.ended) fn();
    }
  }

  async rollback(): Promise<void> {
    if (!this._active) {
      throw new NodeTransactionError('Transaction already completed');
    }
    try {
      await this.client.query('ROLLBACK');
    } finally {
      this._active = false;
      this.client.release();
      for (const fn of this.ended) fn();
    }
  }
}

// ===== PgStore Implementation =====

/**
 * One path cache per table set, so that stores over the same tables in this process — the same
 * mount made twice — see each other's writes.
 */
const pathCaches = new Map<string, PathCache>();

/** The attrs leading an index, per table set, as `ORDERED_INDEX_LEADERS` and the declared indexes add them. */
const indexLeaders = new Map<string, Set<string>>();

/** How `indexLeaders` names an index's leading attr: by its path and the collation it is held in. */
const leaderKey = (attr: string, collation: NodeQueryCollation = 'bytes'): string => `${attr} ${collation}`;

/** The access columns of a row, read under `prefix` (`p_mode` and so on for `p_`). */
const rowOwnership = (row: Record<string, unknown>, prefix = ''): Ownership => ({
  mode: row[`${prefix}mode`] as Mode,
  uid: row[`${prefix}uid`] as UserId,
  gid: row[`${prefix}gid`] as GroupId,
  ...(row[`${prefix}acl`] ? { acl: row[`${prefix}acl`] as ModeACL[] } : {}),
});

const logger = createLogger('pg-store');

/** Ids per statement when the reach refresh lists children. */
const CHILDREN_BATCH = 10000;

export class PgStore implements NodeStore {
  readonly name = 'pg';
  readonly type = 'persistent' as const;
  readonly supportsMount = true;

  private _rootId: NodeId | null = null;
  private initialized = false;
  private tablePrefix: string;
  private pool: Pool;
  /** What `resolveChain` has read; every write below drops what it changes when its transaction ends. */
  private paths: PathCache;
  private plan: PgQueryPlanOptions;
  /** Attrs an index leads with; see `indexLeaders`. */
  private leaders: Set<string>;
  /** Measured subtree sizes, least recently used first; see `scopeSize`. */
  private scopeSizes = new Map<NodeId, { size: number; cap: number; at: number }>();
  /** The reach classes of `reachTable`, as far as this store has read or made them. */
  private classes = new ReachClasses((key, formula) => this.persistClass(key, formula));
  /** `reachPrunes` as `classes` last caught up with it. */
  private prunesSeen = 0;
  /** Transactions holding the shared class lock, with `classes` caught up; see `useClasses`. */
  private classUsers = new WeakSet<PgTransaction>();
  /** Classes this store has made since it last pruned. */
  private classesMade = 0;
  /** The prune `pruneWhenGrown` started, while it runs. */
  private pruning?: Promise<void>;

  constructor(public config: PgStoreConfig) {
    const name = `${config.name}_nodes`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table prefix: ${name}`);
    }
    this.tablePrefix = name;
    this.pool = config.pgPool;
    this.paths = pathCaches.get(name) ?? new PathCache();
    pathCaches.set(name, this.paths);
    this.leaders = indexLeaders.get(name) ?? new Set(ORDERED_INDEX_LEADERS.map((attr) => leaderKey(attr)));
    indexLeaders.set(name, this.leaders);
    this.plan = { ...DEFAULT_QUERY_PLAN, ...config.queryPlan };
  }

  get rootId(): NodeId {
    if (!this._rootId) {
      throw new Error('PgStore not initialized - rootId not available');
    }
    return this._rootId;
  }

  // Table name helpers
  private get nodesTable() {
    return `${this.tablePrefix}`;
  }
  private get attrsTable() {
    return `${this.tablePrefix}_attr`;
  }
  private get hierarchyTable() {
    return `${this.tablePrefix}_lnk`;
  }
  private get auditTable() {
    return `${this.tablePrefix}_audit`;
  }
  /** Every distinct reach formula, numbered: what a node's `reach` column refers to. */
  private get reachTable() {
    return `${this.tablePrefix}_reach`;
  }
  /** Counts the passes that deleted classes from `reachTable`; dropped with it. */
  private get reachPrunes() {
    return `${this.tablePrefix}_reach_prunes`;
  }
  private get treeTables(): TreeTables {
    return { nodes: this.nodesTable, hierarchy: this.hierarchyTable };
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // The tables may have been dropped and made again since another store over them cached a walk.
    this.paths.clear();
    await this.createSchema();

    const existingRoot = await this.findRootNode();

    this.classes.clear();
    this.prunesSeen = await this.readPrunes();
    await this.learnClasses();
    if (existingRoot) {
      this._rootId = existingRoot;
      await this.fillReach();
      await this.pruneClasses();
    } else {
      this._rootId = ulid() as NodeId;
      await this.createRootNode();
    }
    this.classesMade = 0;

    this.initialized = true;
  }

  private async createSchema(): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.nodesTable} (
          id VARCHAR(26) PRIMARY KEY,
          type VARCHAR(64) NOT NULL,
          mode INTEGER NOT NULL DEFAULT 493,
          uid INTEGER NOT NULL DEFAULT 0,
          gid INTEGER NOT NULL DEFAULT 0,
          acl JSONB,
          birth_uid INTEGER NOT NULL,
          birth_time TIMESTAMPTZ NOT NULL,
          change_uid INTEGER NOT NULL,
          change_time TIMESTAMPTZ NOT NULL,
          mod_uid INTEGER NOT NULL,
          mod_time TIMESTAMPTZ NOT NULL,
          softlink VARCHAR(256),
          tier VARCHAR(16),
          reach INTEGER
        )
      `);
      // A table made before `reach` gains the column here, empty; `fillReach` fills it. Looked up
      // first and bounded, as the audit trail's `cause` is below.
      const hasReach = await conn.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'reach'`,
        [this.nodesTable],
      );
      if (hasReach.rowCount === 0) {
        await conn.query(`SET lock_timeout = '10s'`);
        try {
          await conn.query(`ALTER TABLE ${this.nodesTable} ADD COLUMN IF NOT EXISTS reach INTEGER`);
        } finally {
          await conn.query(`RESET lock_timeout`);
        }
      }
      // A number never changes its formula and is never given again, so a process keeps what it
      // has read until `pruneClasses` deletes the class.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.reachTable} (
          id SERIAL PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          formula JSONB NOT NULL
        )
      `);
      await conn.query(`CREATE SEQUENCE IF NOT EXISTS ${this.reachPrunes} OWNED BY ${this.reachTable}.id`);

      // `node_type` repeats the node's type beside its attrs, so one index can hold a type's rows
      // in the order of an attr (`type_name_sorted_<language>`); no attrs index reaches the nodes table.
      // Every insert sets it. A table made before the column has it filled once for its named
      // rows, the only ones that index holds, and an attrs update fills it for a row without.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.attrsTable} (
          node_id VARCHAR(26) PRIMARY KEY REFERENCES ${this.nodesTable}(id) ON DELETE CASCADE,
          node_type VARCHAR(64),
          attributes JSONB NOT NULL DEFAULT '{}'
        )
      `);
      const typed = await conn.query(
        `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'node_type' AND NOT attisdropped`,
        [this.attrsTable],
      );
      if (typed.rows.length === 0) {
        await conn.query(`ALTER TABLE ${this.attrsTable} ADD COLUMN node_type VARCHAR(64)`);
        await conn.query(`
          UPDATE ${this.attrsTable} a SET node_type = n.type
          FROM ${this.nodesTable} n
          WHERE n.id = a.node_id AND (${attrTextExpr(TYPED_ORDER_REF, 'a.attributes')}) IS NOT NULL
        `);
      }

      // PK is (parent_id, name) to support hard links - same child can appear
      // multiple times under same parent with different names
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.hierarchyTable} (
          parent_id VARCHAR(26) NOT NULL REFERENCES ${this.nodesTable}(id) ON DELETE CASCADE,
          child_id VARCHAR(26) NOT NULL REFERENCES ${this.nodesTable}(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (parent_id, name)
        )
      `);
      // A child count is an index-only scan, which stays index-only only while the visibility map
      // is fresh. Pipeline instances are made and pruned all day, and at the default scale factor
      // (a fifth of the table) a vacuum comes round only after hundreds of thousands of changes,
      // leaving the count reading most of its rows from the heap (ein/core#747). Set only when
      // missing: the ALTER takes a lock that would wait behind a running vacuum on every boot.
      const vacuumOptions = ['autovacuum_vacuum_scale_factor=0.01', 'autovacuum_vacuum_insert_scale_factor=0.01'];
      const options = await conn.query(`SELECT reloptions FROM pg_class WHERE oid = $1::regclass`, [this.hierarchyTable]);
      const set: string[] = options.rows[0]?.reloptions ?? [];
      if (!vacuumOptions.every((option) => set.includes(option))) {
        await conn.query(`ALTER TABLE ${this.hierarchyTable} SET (${vacuumOptions.join(', ')})`);
      }

      // Create indexes for common queries
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.hierarchyTable}_child_idx
        ON ${this.hierarchyTable}(child_id)
      `);
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.hierarchyTable}_parent_child_idx
        ON ${this.hierarchyTable}(parent_id, child_id)
      `);

      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.nodesTable}_type_idx
        ON ${this.nodesTable}(type)
      `);
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.hierarchyTable}_parent_order_idx
        ON ${this.hierarchyTable}(parent_id, position, name);
      `);
      // Backlinks: "what points at this path, or under it?" (findSoftlinks, findSoftlinksUnder).
      // Byte-ordered, so a path prefix is one range scan whatever the database's collation, and
      // partial, since only softlink nodes have a target at all. It takes the place of an index in
      // the default collation, which cannot serve that range.
      await conn.query(`DROP INDEX IF EXISTS ${this.nodesTable}_softlink_idx`);
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.nodesTable}_softlink_c_idx
        ON ${this.nodesTable} ((softlink COLLATE "C"))
        WHERE softlink IS NOT NULL
      `);

      // The audit trail: one row per node write, inserted in the write's own
      // transaction (`appendAudit`). The id is a monotonic ULID, so ordering by it is
      // write order: a read walks an index newest first, or the primary key forward from `after`.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.auditTable} (
          id VARCHAR(26) PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL,
          uid INTEGER NOT NULL,
          sid TEXT,
          cause VARCHAR(26),
          op VARCHAR(16) NOT NULL,
          node_id TEXT NOT NULL,
          node_type VARCHAR(64) NOT NULL,
          path TEXT NOT NULL,
          from_path TEXT,
          attrs JSONB,
          props JSONB
        )
      `);
      // A trail made before it had `cause` gains the column here. Looked up first, so a boot
      // that has nothing to add asks for no exclusive lock, and bounded, so one stuck behind a
      // long reader fails instead of hanging (ein/core#41).
      const hasCause = await conn.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'cause'`,
        [this.auditTable],
      );
      if (hasCause.rowCount === 0) {
        await conn.query(`SET lock_timeout = '10s'`);
        try {
          await conn.query(`ALTER TABLE ${this.auditTable} ADD COLUMN IF NOT EXISTS cause VARCHAR(26)`);
        } finally {
          await conn.query(`RESET lock_timeout`);
        }
      }
      await conn.query(`CREATE INDEX IF NOT EXISTS ${this.auditTable}_uid_idx ON ${this.auditTable} (uid, id)`);
      await conn.query(`CREATE INDEX IF NOT EXISTS ${this.auditTable}_node_idx ON ${this.auditTable} (node_id, id)`);
      await conn.query(`CREATE INDEX IF NOT EXISTS ${this.auditTable}_path_idx ON ${this.auditTable} (path text_pattern_ops)`);
      await conn.query(`CREATE INDEX IF NOT EXISTS ${this.auditTable}_cause_idx ON ${this.auditTable} (cause, id) WHERE cause IS NOT NULL`);

      // Attribute-query indexes. The expressions must match what query.ts
      // emits (same COALESCE shape, same COLLATE "C") or the planner won't use
      // them — attrSortExpr() is the single source for both.
      const sha256Expr = attrSortExpr('sha256');

      // Serves the per-hash equality lookups the `duplicates` command runs after
      // grouping by checksum. Partial: most attr rows have no sha256, and an
      // `= $1` lookup implies IS NOT NULL so the planner can still use it.
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_sha256_idx
        ON ${this.attrsTable} ((${sha256Expr}), node_id)
        WHERE (attributes->>'sha256') IS NOT NULL
      `);
      // Every embedding of one kind, in id order: the batch passes page through a kind with a
      // keyset cursor on the node id, which this index serves from the cursor on. Without it a
      // page is a walk of the whole attrs table in id order, through the shared buffers the
      // vector indexes need for search.
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_embedding_type_idx
        ON ${this.attrsTable} ((${attrSortExpr('embeddingType')}), node_id)
        WHERE (attributes->>'embeddingType') IS NOT NULL
      `);
      // The indexes on module attrs — capture time, faces, album spans, events, residences, dated
      // partnerships, cameras — are the modules' to declare (`mod.json` `indexes`) and are made by
      // `ensureAttrIndexes` at `mod setup`, under the names they had here, so an archive that
      // already has them builds nothing.

      // Substring search on a name — the `contains` operator. `%foo%` cannot be
      // rewritten into a range, so no btree can serve it; a trigram index makes
      // it a lookup.
      //
      // GIN over the *uncollated* projection, which is what
      // `conditionSql`'s `contains` branch emits — a COLLATE "C" wrapper here
      // would be a different expression and the planner would ignore the index.
      // Not partial: `name` is required on files and carried by most other node
      // types, so there is no minority to exclude.
      await conn.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_name_trgm_idx
        ON ${this.attrsTable} USING GIN ((${attrTextExpr('name')}) gin_trgm_ops)
      `);

      // The `name_sorted_<language>` and `type_name_sorted_<language>` indexes take the place of
      // these two, which held names in Swedish alone.
      await conn.query(`DROP INDEX IF EXISTS ${this.attrsTable}_name_sorted_idx`);
      await conn.query(`DROP INDEX IF EXISTS ${this.attrsTable}_type_name_sorted_idx`);
      await this.createAttrIndexes(conn, CORE_ATTR_INDEXES);

      // One type's named rows in name order, per language — search's people or albums by name.
      // `name_sorted_<language>` cannot serve that: the type is a filter on the joined nodes, which
      // the planner takes as independent of the name, so it expects a few rows of a type where a
      // fifth of the names may be people, and bitmap-scans and sorts every name past the cursor.
      for (const language of NAME_LANGUAGES) {
        await conn.query(`
          CREATE INDEX IF NOT EXISTS ${this.attrsTable}_type_name_sorted_${language}_idx
          ON ${this.attrsTable} (node_type, (${attrSortExpr(TYPED_ORDER_REF, 'attributes', language)}), node_id)
          WHERE (${attrTextExpr(TYPED_ORDER_REF)}) IS NOT NULL
        `);
      }

      // Counts the derivatives, which is how the dashboard knows how much of
      // the library is *originals* and therefore how much is left to index.
      // Partial and key-less: the only question asked of it is "how many rows
      // have this key", so the predicate is the whole index and it stays a
      // fraction of the size of the table it replaces a scan over.
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_source_idx
        ON ${this.attrsTable} (node_id)
        WHERE (attributes->>'sourceId') IS NOT NULL
      `);

      // Planner statistics for the one expression every media query filters on
      // and no index carries stats for: `sourceId IS NULL`, the "not a
      // rendition" predicate. A partial index gets no statistics of its own, and
      // for `IS NULL` on an expression it knows nothing about PostgreSQL assumes
      // one row in two hundred — far too few, which makes a skip-scan plus a full
      // sort look cheaper than an ordered scan of the time index. The object is
      // created once; an ANALYZE straight after is what fills it, since
      // autovacuum only comes round on its own schedule.
      const sourceStats = `${this.attrsTable}_source_stats`;
      const existing = await conn.query(`SELECT 1 FROM pg_statistic_ext WHERE stxname = $1`, [sourceStats]);
      if (existing.rows.length === 0) {
        await conn.query(`CREATE STATISTICS IF NOT EXISTS ${sourceStats} ON ((attributes->>'sourceId')) FROM ${this.attrsTable}`);
        await conn.query(`ANALYZE ${this.attrsTable}`);
      }

      // Pipeline instance state, for the dashboard's status counts. Partial on
      // pipelineName so the index covers instance nodes only (a few percent of
      // the table), and **status leads**: every query filters status with
      // eq/in and groups by pipelineName, so status is the selective column.
      // It cannot serve an index-only scan (an expression index never does), so a
      // count reads each matched row: pipeline-overview counts only the
      // statuses that are not `completed`, which are few.
      //
      // Leading with pipelineName instead would leave the selectivity to the
      // partial predicate, and there are no statistics for a JSONB expression —
      // the planner estimates `IS NOT NULL` at ~99% and picks a seq scan. Hence
      // also the ANALYZE below.
      //
      // `status` itself has statistics, filled by that ANALYZE. Without them `= 'running'` is
      // taken for one row in two hundred of the whole table, where it matches a handful, and
      // the dashboard's running lists get a parallel plan whose workers take longer to start
      // than the index scan takes to answer (ein/core#747).
      await conn.query(`CREATE STATISTICS IF NOT EXISTS ${this.attrsTable}_status_stats ON ((attributes->>'status')) FROM ${this.attrsTable}`);
      const statusExpr = attrSortExpr('status');
      const pipelineExpr = attrSortExpr('pipelineName');
      const completedAtExpr = attrSortExpr('completedAt');

      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_pipeline_status_idx
        ON ${this.attrsTable} ((${statusExpr}), (${pipelineExpr}), node_id)
        WHERE (attributes->>'pipelineName') IS NOT NULL
      `);
      // Serves instance listings ordered newest-first and pruning by age.
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_pipeline_completed_idx
        ON ${this.attrsTable} ((${completedAtExpr}), node_id)
        WHERE (attributes->>'pipelineName') IS NOT NULL
      `);
      // The same for step nodes, for pipeline-overview's unfinished-step count, which is
      // otherwise a scan of the whole attrs table.
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_step_status_idx
        ON ${this.attrsTable} ((${statusExpr}), node_id)
        WHERE (attributes->>'stepName') IS NOT NULL
      `);
      // Steps whose input nothing can process, which `health` counts. Only failed steps carry a
      // cause, so the index holds few rows; the planner proves its predicate from the query's
      // `= $1` on the same projection.
      const causeExpr = attrSortExpr('cause');
      await conn.query(`
        CREATE INDEX IF NOT EXISTS ${this.attrsTable}_step_cause_idx
        ON ${this.attrsTable} ((${causeExpr}), node_id)
        WHERE (attributes->>'stepName') IS NOT NULL AND (attributes->>'cause') IS NOT NULL
      `);

      // A fresh index on an existing table is unusable until it has statistics,
      // and createSchema runs on every boot against a table that may already
      // hold millions of rows — autovacuum would get there eventually, leaving
      // the dashboard on seq scans until it did.
      await conn.query(`ANALYZE ${this.attrsTable}`);
    } finally {
      conn.release();
    }
  }

  /**
   * Find the root node by looking for nodes that have no parent in the hierarchy.
   * If multiple orphan nodes exist, returns the oldest one (by birth_time).
   */
  private async findRootNode(): Promise<NodeId | null> {
    const conn = await this.pool.connect();
    try {
      const result = await conn.query<{ id: string }>(`
        SELECT n.id
        FROM ${this.nodesTable} n
        LEFT JOIN ${this.hierarchyTable} h
          ON h.child_id = n.id
        WHERE h.child_id IS NULL
        ORDER BY n.birth_time ASC
        LIMIT 1
      `);

      return result.rows[0]?.id as NodeId | undefined ?? null;
    } finally {
      conn.release();
    }
  }

  private async createRootNode(): Promise<void> {
    const conn = await this.pool.connect();
    try {
      const now = Date.now();

      await conn.query(
        `INSERT INTO ${this.nodesTable} (
          id, type, mode, uid, gid,
          birth_uid, birth_time, change_uid, change_time, mod_uid, mod_time, reach
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, to_timestamp($7/1000.0), $6, to_timestamp($7/1000.0), $6, to_timestamp($7/1000.0), $8
        )`,
        [
          this.rootId,
          NODE_TYPE_DIRECTORY,
          this.config.rootMode ?? 0o755,
          ADMIN_UID,
          ADMIN_GID,
          ADMIN_UID,
          now,
          await this.classes.reachOf([], true),
        ],
      );

      await conn.query(
        `INSERT INTO ${this.attrsTable} (node_id, node_type, attributes)
         VALUES ($1, $2, $3)`,
        [this.rootId, NODE_TYPE_DIRECTORY, JSON.stringify({})],
      );
    } finally {
      conn.release();
    }
  }

  async dispose(): Promise<void> {
    // Pool is managed externally, don't close it
    this.initialized = false;
    await this.pruning;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.initialized) return false;

    try {
      const conn = await this.pool.connect();
      try {
        await conn.query('SELECT 1');
        return true;
      } finally {
        conn.release();
      }
    } catch {
      return false;
    }
  }

  // ===== Attribute Queries =====

  /**
   * One statement, or for a query within a large subtree the P2 loop; see `PgQueryPlanOptions`.
   * A query with only `notWithinIds` is always P2: it reads in index order and walks up from each
   * batch, rather than materializing what it leaves out.
   */
  async queryNodes<T extends NodeAttrs = NodeAttrs>(
    query: StoreNodeQuery,
    tx?: Transaction,
  ): Promise<NodeQueryRow<T>[]> {
    const { withinId, notWithinIds, ...plain } = query;
    const scope: StoreScope = { withinId, notWithinIds: notWithinIds?.length ? notWithinIds : undefined };
    const admitted = query.reader === undefined ? undefined : await this.admittedClasses(query.reader, tx);
    if (scope.withinId === undefined && scope.notWithinIds === undefined) return await this.runQuery<T>(plain, admitted, tx);
    if (scope.withinId !== undefined && await this.readsMembers(scope.withinId, plain, tx)) return await this.runQuery<T>({ ...plain, ...scope }, admitted, tx);
    return await this.walkScoped<T>(plain, scope, admitted, tx);
  }

  /** `admitted`: the reach classes admitting `query.reader`, when there is one. */
  private async runQuery<T extends NodeAttrs>(query: StoreNodeQuery, admitted: number[] | undefined, tx?: Transaction): Promise<NodeQueryRow<T>[]> {
    const sql = buildQuerySql(query, this.nodesTable, this.attrsTable, this.hierarchyTable, (ref) => this.leadsIndex({ ref }), admitted);
    const rows = await this.runParameterized(sql, tx);

    return rows.map((row) => ({
      // `count` is 0 by design: the query skips the hierarchy join.
      node: this.rowToNode<T>(row),
      sortValue: (row.sort_value as string | null) ?? null,
    }));
  }

  /** Whether a query within `rootId` takes P1: a small subtree, or an order no index can serve. */
  private async readsMembers(rootId: NodeId, query: StoreNodeQuery, tx?: Transaction): Promise<boolean> {
    const threshold = this.plan.scopeThreshold;
    if (threshold === Infinity) return true;
    if (threshold <= 0) return false;
    if (query.orderBy && !this.leadsIndex(query.orderBy)) return true;
    return (await this.scopeSize(rootId, threshold, tx)) <= threshold;
  }

  private leadsIndex({ ref, collation, match }: Pick<NodeQueryOrder, 'ref' | 'collation' | 'match'>): boolean {
    if (match !== undefined) return false;
    if (typeof ref === 'string') return this.leaders.has(leaderKey(ref, collation));
    return 'path' in ref && this.leaders.has(leaderKey(ref.path.join('.'), collation));
  }

  /**
   * P2: the query without its scope, read from the cursor a batch at a time in the order it asks
   * for (`taken_utc` and the like, or the attrs primary key in id order), keeping the rows one
   * up-walk per batch places in scope, until `limit` are kept or the index has no more.
   */
  private async walkScoped<T extends NodeAttrs>(query: StoreNodeQuery, scope: StoreScope, admitted: number[] | undefined, tx?: Transaction): Promise<NodeQueryRow<T>[]> {
    const kept: NodeQueryRow<T>[] = [];
    if (query.limit <= 0) return kept;
    const max = this.plan.batchMax;
    // A subtree may hold few of the rows read. Leaving trees out of a library view drops few, so a
    // first batch a little over the page fills it, and the page reads no rows it does not keep.
    const first = scope.withinId !== undefined ? Math.max(2 * query.limit, MIN_SCOPE_BATCH) : query.limit + Math.ceil(query.limit / 8) + 1;
    let batch = Math.min(first, max);
    let after = query.after;
    for (;;) {
      const rows = await this.runQuery<T>({ ...query, after, limit: batch }, admitted, tx);
      if (rows.length === 0) return kept;
      const within = await this.withinScope(rows.map((row) => row.node.id), scope, tx);
      for (const row of rows) {
        if (!within.has(row.node.id)) continue;
        kept.push(row);
        if (kept.length === query.limit) return kept;
      }
      if (rows.length < batch) return kept;
      const last = rows[rows.length - 1];
      after = { value: last.sortValue, id: last.node.id };
      batch = Math.min(batch * 2, max);
    }
  }

  /**
   * Of `ids`, those within `scope.withinId` (when given) and within none of `scope.notWithinIds`.
   * With roots to leave out, the walk goes on past the within root, which may lie inside one.
   */
  private async withinScope(ids: NodeId[], scope: StoreScope, tx?: Transaction): Promise<Set<NodeId>> {
    const roots = [...(scope.withinId !== undefined ? [scope.withinId] : []), ...(scope.notWithinIds ?? [])];
    const stops = scope.notWithinIds ?? roots;
    const reached = new Map<NodeId, Set<NodeId>>();
    for (const row of await this.runParameterized(buildUpwalkSql([...new Set(ids)], roots, stops, this.treeTables), tx)) {
      const origin = row.origin as NodeId;
      const at = reached.get(origin) ?? new Set<NodeId>();
      at.add(row.at as NodeId);
      reached.set(origin, at);
    }
    return new Set(ids.filter((id) => {
      const at = reached.get(id);
      if (scope.withinId !== undefined && !at?.has(scope.withinId)) return false;
      return !(scope.notWithinIds ?? []).some((root) => at?.has(root));
    }));
  }

  /**
   * A subtree's size up to `cap + 1`, remembered for `scopeCacheMs`: the plan choice asks it of
   * every page. A size gone stale costs only a slower plan, since both plans answer alike.
   */
  private async scopeSize(rootId: NodeId, cap: number, tx?: Transaction): Promise<number> {
    const now = Date.now();
    const known = this.scopeSizes.get(rootId);
    this.scopeSizes.delete(rootId);
    if (known && known.cap === cap && now - known.at < this.plan.scopeCacheMs) {
      this.scopeSizes.set(rootId, known);
      return known.size;
    }
    const size = await this.countWithin(rootId, cap + 1, tx);
    this.scopeSizes.set(rootId, { size, cap, at: now });
    if (this.scopeSizes.size > SCOPE_CACHE_ROOTS) this.scopeSizes.delete(this.scopeSizes.keys().next().value!);
    return size;
  }

  async countWithin(rootId: NodeId, cap: number, tx?: Transaction): Promise<number> {
    if (cap <= 0) return 0;
    const rows = await this.runParameterized(buildScopeSizeSql(rootId, cap, this.treeTables), tx);
    return Math.min(Number(rows[0]?.size) || 0, cap);
  }

  /**
   * `<attrs>_<name>_idx` over each declared attr's sort expression and the node id, partial on the
   * `partial` attr being set — the shape every attr index here has, so the planner matches it to
   * what `query.ts` emits; a `trigram` one is a GIN index over the attr's text, for `contains`, and
   * a `statistics` one no index, only the planner's statistics on the attr's text.
   * `IF NOT EXISTS`: on every boot after the first this is a catalogue
   * lookup per index. An index's expression is not part of its identity, so changing a declared
   * index means giving it a new name.
   */
  async ensureAttrIndexes(indexes: IndexDecl[]): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await this.createAttrIndexes(conn, indexes);
    } finally {
      conn.release();
    }
  }

  private async createAttrIndexes(conn: PoolClient, indexes: IndexDecl[]): Promise<void> {
    for (const index of indexes) {
      const where = index.partial ? ` WHERE (${attrTextExpr(attrRefOf(index.partial))}) IS NOT NULL` : '';
      if (index.using === 'trigram') {
        // Over the uncollated projection, as the name's trigram index is: `contains` emits it.
        await conn.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        const expr = attrTextExpr(attrRefOf(index.on[0]));
        await conn.query(`CREATE INDEX IF NOT EXISTS ${this.attrsTable}_${index.name}_idx ON ${this.attrsTable} USING GIN ((${expr}) gin_trgm_ops)${where}`);
        // Statistics for the attr, as for `sourceId`: without them the planner takes a substring to
        // match one row in two hundred of the whole table, and walks the table in id order for a
        // query's limit rather than ask the index about an attr few rows carry.
        await this.createAttrStatistics(conn, index.name, expr);
        continue;
      }
      if (index.using === 'statistics') {
        // Without them the planner takes `IS NULL` on the attr to hold for one row in two hundred,
        // where nearly every row lacks it, and reads a whole table to join it rather than the
        // rows it was asked about by key.
        await this.createAttrStatistics(conn, index.name, attrTextExpr(attrRefOf(index.on[0])));
        continue;
      }
      const keys = index.on.map((attr) => `(${attrSortExpr(attrRefOf(attr), 'attributes', index.collation)})`).join(', ');
      await conn.query(`CREATE INDEX IF NOT EXISTS ${this.attrsTable}_${index.name}_idx ON ${this.attrsTable} (${keys}, node_id)${where}`);
      // An order by the leading attr excludes the rows without it, which a partial index on that
      // same attr leaves out too; one partial on another attr cannot serve it.
      if (index.on.length > 0 && (!index.partial || index.partial === index.on[0])) this.leaders.add(leaderKey(index.on[0], index.collation));
    }
  }

  /**
   * `<attrs>_<name>_stats` over `expr`, filled by an ANALYZE once when it is made: autovacuum only
   * comes round on its own schedule.
   */
  private async createAttrStatistics(conn: PoolClient, name: string, expr: string): Promise<void> {
    const stats = `${this.attrsTable}_${name}_stats`;
    if ((await conn.query(`SELECT 1 FROM pg_statistic_ext WHERE stxname = $1`, [stats])).rows.length > 0) return;
    await conn.query(`CREATE STATISTICS IF NOT EXISTS ${stats} ON ((${expr})) FROM ${this.attrsTable}`);
    await conn.query(`ANALYZE ${this.attrsTable}`);
  }

  async groupCount(query: StoreAggregateQuery, tx?: Transaction): Promise<AggregateBucket[]> {
    const sql = buildAggregateSql(
      { ...query, notWithinIds: query.notWithinIds?.length ? query.notWithinIds : undefined },
      this.nodesTable,
      this.attrsTable,
      this.hierarchyTable,
      query.reader === undefined ? undefined : await this.admittedClasses(query.reader, tx),
    );
    const rows = await this.runParameterized(sql, tx);
    const countNames = Object.keys(query.counts ?? {});

    return rows.map((row) => ({
      key: query.group.map((_, i) => String(row[`key_${i}`])) as [string, ...string[]],
      // COUNT(*) comes back as bigint, which the driver serializes as a string.
      count: Number(row.count),
      // SUM over numeric does the same. Absent unless the query asked for it,
      // so a caller cannot mistake "no sum requested" for "summed to zero".
      ...(query.sum !== undefined ? { sum: Number(row.sum) } : {}),
      ...(query.counts !== undefined ? { counts: Object.fromEntries(countNames.map((name, i) => [name, Number(row[`c_${i}`])])) } : {}),
    }));
  }

  /**
   * Resolve many ids to absolute paths in a single recursive walk up the
   * hierarchy table.
   *
   * Touches only `(parent_id, child_id, name)` — no node rows, no attrs.
   *
   * Hard links fan out naturally into multiple rows. The depth cap is a
   * cycle guard — the VFS forbids them, but a malformed hierarchy must not
   * spin forever inside PostgreSQL.
   */
  async resolvePaths(ids: NodeId[], tx?: Transaction): Promise<Map<NodeId, StoredPath[]>> {
    const result = new Map<NodeId, StoredPath[]>();
    if (ids.length === 0) return result;

    const rootId = this.rootId;
    const unique = [...new Set(ids)];

    // The root itself has no hierarchy edge, so it never appears below.
    if (unique.includes(rootId)) result.set(rootId, [{ path: '/', parentId: rootId, ancestors: [] }]);

    const sql: SqlQuery = {
      text: `
        WITH RECURSIVE up AS (
          SELECT h.child_id AS origin_id, h.parent_id AS direct_parent, h.parent_id,
                 h.name::text AS path, ARRAY[h.parent_id]::text[] AS ancestors, 1 AS depth
          FROM ${this.hierarchyTable} h
          WHERE h.child_id = ANY($1)
          UNION ALL
          SELECT up.origin_id, up.direct_parent, h.parent_id,
                 h.name || '/' || up.path, h.parent_id || up.ancestors, up.depth + 1
          FROM ${this.hierarchyTable} h
          JOIN up ON h.child_id = up.parent_id
          WHERE up.depth < ${MAX_PATH_DEPTH}
        )
        SELECT origin_id, direct_parent, '/' || path AS abs_path, ancestors
        FROM up
        WHERE parent_id = $2
      `,
      values: [unique, rootId],
    };

    for (const row of await this.runParameterized(sql, tx)) {
      const id = row.origin_id as NodeId;
      const entry: StoredPath = { path: row.abs_path as string, parentId: row.direct_parent as NodeId, ancestors: row.ancestors as NodeId[] };
      const paths = result.get(id);
      if (paths) paths.push(entry);
      else result.set(id, [entry]);
    }

    return result;
  }

  /** One lookup on the hierarchy table's `child_id` index — no node rows, no attrs. */
  async getParentLinks(childId: NodeId, tx?: Transaction): Promise<{ parentId: NodeId; name: string }[]> {
    const sql: SqlQuery = {
      text: `SELECT parent_id, name FROM ${this.hierarchyTable} WHERE child_id = $1`,
      values: [childId],
    };

    const rows = await this.runParameterized(sql, tx);
    return rows.map((row) => ({ parentId: row.parent_id as NodeId, name: row.name as string }));
  }

  /**
   * The same index, asked once for the whole batch. Much cheaper than
   * `resolvePaths` for a caller that wants only the parent: no recursion, and
   * no ancestor names built into strings.
   */
  async getParentLinksMany(childIds: NodeId[], tx?: Transaction): Promise<Map<NodeId, ParentLink[]>> {
    const result = new Map<NodeId, ParentLink[]>();
    if (childIds.length === 0) return result;

    const sql: SqlQuery = {
      text: `SELECT child_id, parent_id, name FROM ${this.hierarchyTable} WHERE child_id = ANY($1)`,
      values: [[...new Set(childIds)]],
    };

    for (const row of await this.runParameterized(sql, tx)) {
      const id = row.child_id as NodeId;
      const link: ParentLink = { parentId: row.parent_id as NodeId, name: row.name as string };
      const links = result.get(id);
      if (links) links.push(link);
      else result.set(id, [link]);
    }

    return result;
  }

  /** Bulk fetch by id, deliberately without the link-count join `getNodeQuery` carries. */
  async getNodes<T extends NodeAttrs = NodeAttrs>(
    ids: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const result = new Map<NodeId, Node<T>>();
    if (ids.length === 0) return result;

    // Inside a transaction the rows are locked, as `getNode` locks its row: a batched write reads
    // what it is about to write this way.
    const sql: SqlQuery = {
      text: `
        SELECT
          n.id, n.type, n.mode, n.uid, n.gid, n.acl, n.softlink, n.tier,
          n.birth_uid, n.change_uid, n.mod_uid,
          extract(epoch FROM n.birth_time) * 1000 AS birth_time,
          extract(epoch FROM n.change_time) * 1000 AS change_time,
          extract(epoch FROM n.mod_time) * 1000 AS mod_time,
          a.attributes
        FROM ${this.nodesTable} n
        LEFT JOIN ${this.attrsTable} a ON a.node_id = n.id
        WHERE n.id = ANY($1)
        ${tx ? 'FOR UPDATE OF n' : ''}
      `,
      values: [[...new Set(ids)]],
    };

    for (const row of await this.runParameterized(sql, tx)) {
      const node = this.rowToNode<T>(row);
      result.set(node.id, node);
    }

    return result;
  }

  /** The access columns alone: no attrs join, which is most of `getNodes`' row. */
  async getOwnership(ids: NodeId[], tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const result = new Map<NodeId, Ownership>();
    if (ids.length === 0) return result;

    const sql: SqlQuery = {
      text: `SELECT id, mode, uid, gid, acl FROM ${this.nodesTable} WHERE id = ANY($1)`,
      values: [[...new Set(ids)]],
    };

    for (const row of await this.runParameterized(sql, tx)) {
      result.set(row.id as NodeId, {
        mode: row.mode as Mode,
        uid: row.uid as UserId,
        gid: row.gid as GroupId,
        ...(row.acl ? { acl: row.acl as ModeACL[] } : {}),
      });
    }

    return result;
  }

  // ===== Reach =====
  //
  // Every node's `reach` names a class of `reachTable`: who can get to it along some path (see
  // `vfs/reach.ts`). Each write below that gives a node a parent, takes one away, or changes who a
  // node lets through refreshes the reach under it in its own transaction, so reach is never
  // stale. A refresh locks the rows it is about to compute before it reads their parents, and a
  // write under a parent share-locks the parent: a refresh running at the same time in another
  // transaction then either waits for this one or is waited for, and the later of the two reads
  // what the earlier wrote.
  //
  // Classes no node refers to are deleted by `pruneClasses`, at boot and once this store has made
  // `reachPruneAfter` new ones. A transaction that computes reach from `classes` first takes
  // `useClasses`, so it never writes a number a prune deleted.

  async reachable(access: Access, ids: NodeId[], tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const result = new Map<NodeId, Ownership>();
    if (ids.length === 0) return result;
    const rows = await this.runParameterized({
      text: `SELECT id, mode, uid, gid, acl, reach FROM ${this.nodesTable} WHERE id = ANY($1)`,
      values: [[...new Set(ids)]],
    }, tx);
    if (rows.some((row) => row.reach !== null && !this.classes.has(row.reach as number))) await this.learnClasses(tx);
    const admitted = this.classes.admitted(access);
    for (const row of rows) if (admitted.has(row.reach as number)) result.set(row.id as NodeId, rowOwnership(row));
    return result;
  }

  async reachNamed(): Promise<{ uids: UserId[]; gids: GroupId[] }> {
    const rows = await this.runParameterized({
      text: `SELECT formula FROM ${this.reachTable} WHERE id IN (SELECT DISTINCT reach FROM ${this.nodesTable})`,
      values: [],
    });
    return namedBy(rows.map((row) => row.formula as ReachFormula));
  }

  /** The classes admitting `access`, after reading any another process has made. */
  private async admittedClasses(access: Access, tx?: Transaction): Promise<number[]> {
    await this.learnClasses(tx);
    return [...this.classes.admitted(access)];
  }

  /** Reads the classes made since the last read: by this store's earlier runs, or another process. */
  private async learnClasses(tx?: Transaction): Promise<void> {
    const rows = await this.runParameterized({
      text: `SELECT id, formula FROM ${this.reachTable} WHERE id > $1 ORDER BY id`,
      values: [this.classes.latest],
    }, tx);
    this.classes.learn(rows.map((row) => ({ id: row.id as number, formula: row.formula as ReachFormula })));
  }

  private async readPrunes(): Promise<number> {
    const rows = await this.runParameterized({ text: `SELECT last_value, is_called FROM ${this.reachPrunes}`, values: [] });
    return rows[0].is_called ? Number(rows[0].last_value) : 0;
  }

  /**
   * Holds off `pruneClasses` until `tx` ends, and drops from `classes` what a prune since the last
   * look deleted: until then this process could hand out a deleted number. Once per transaction;
   * when it ends, the classes are pruned if this store has made enough new ones.
   */
  private async useClasses(tx: PgTransaction): Promise<void> {
    if (this.classUsers.has(tx)) return;
    tx.onEnd(() => this.pruneWhenGrown());
    // Two statements, so the counter is read after the lock is granted.
    const [, counter] = await tx.client.query(
      `SELECT pg_advisory_xact_lock_shared(hashtext('${this.reachTable}')); SELECT last_value, is_called FROM ${this.reachPrunes}`,
    ) as unknown as { rows: { last_value: string; is_called: boolean }[] }[];
    this.classUsers.add(tx);
    const prunes = counter.rows[0].is_called ? Number(counter.rows[0].last_value) : 0;
    if (prunes === this.prunesSeen) return;
    const known = this.classes.known();
    const kept = await tx.client.query<{ id: number }>(`SELECT id FROM ${this.reachTable} WHERE id = ANY($1)`, [known]);
    const present = new Set(kept.rows.map((row) => row.id));
    this.classes.forget(known.filter((id) => !present.has(id)));
    this.prunesSeen = prunes;
  }

  /**
   * Starts `pruneClasses` in the background once this store has made `reachPruneAfter` classes
   * since it last pruned. One held off by a write is tried again when the next transaction using
   * the classes ends.
   */
  private pruneWhenGrown(): void {
    if (!this.initialized || this.pruning || this.classesMade < (this.config.reachPruneAfter ?? REACH_PRUNE_AFTER)) return;
    this.pruning = this.pruneClasses()
      .catch((error) => logger.warn('reach class prune failed', { table: this.reachTable, error: String(error) }))
      .finally(() => {
        this.pruning = undefined;
      });
  }

  /**
   * Deletes the classes no node refers to. They are looked for first without the class lock, so
   * when there are none no write waits; otherwise the lock is tried, and under it only those are
   * looked for again, one more scan of the nodes table that writes computing reach wait for. A
   * class made meanwhile is not among them. Left for later while a transaction holds `useClasses`.
   * Other processes drop the deleted classes in their next `useClasses`.
   */
  private async pruneClasses(): Promise<void> {
    // DISTINCT rather than NOT IN: Postgres hashes the one, while the other may be compared row by row.
    const referenced = `SELECT DISTINCT reach FROM ${this.nodesTable} WHERE reach IS NOT NULL`;
    const started = Date.now();
    const unused = await this.runParameterized({ text: `SELECT id FROM ${this.reachTable} WHERE id NOT IN (${referenced})`, values: [] });
    if (unused.length === 0) {
      this.classesMade = 0;
      return;
    }
    const tx = await this.beginTransaction() as PgTransaction;
    try {
      const lock = await tx.client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`, [this.reachTable]);
      if (!lock.rows[0].locked) {
        await tx.rollback();
        return;
      }
      this.classesMade = 0;
      const deleted = await tx.client.query<{ id: number }>(
        `DELETE FROM ${this.reachTable} WHERE id = ANY($1) AND id NOT IN (${referenced} AND reach = ANY($1)) RETURNING id`,
        [unused.map((row) => row.id as number)],
      );
      if (deleted.rows.length === 0) {
        await tx.commit();
        return;
      }
      const counter = await tx.client.query<{ prunes: string }>(`SELECT nextval('${this.reachPrunes}') AS prunes`);
      await tx.commit();
      this.classes.forget(deleted.rows.map((row) => row.id));
      const prunes = Number(counter.rows[0].prunes);
      if (prunes === this.prunesSeen + 1) this.prunesSeen = prunes;
      logger.info('reach classes pruned', { table: this.reachTable, deleted: deleted.rows.length, ms: Date.now() - started });
    } catch (error) {
      if (tx.active) await tx.rollback();
      throw error;
    }
  }

  /**
   * Stores a new class outside any transaction: one a rolled-back write made is merely unused until
   * `pruneClasses`, and every process agrees on its number.
   */
  private async persistClass(key: string, formula: ReachFormula): Promise<number> {
    const conn = await this.pool.connect();
    try {
      const inserted = await conn.query<{ id: number }>(
        `INSERT INTO ${this.reachTable} (key, formula) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING id`,
        [key, JSON.stringify(formula)],
      );
      if (inserted.rows.length > 0) {
        this.classesMade++;
        return inserted.rows[0].id;
      }
      return (await conn.query<{ id: number }>(`SELECT id FROM ${this.reachTable} WHERE key = $1`, [key])).rows[0].id;
    } finally {
      conn.release();
    }
  }

  /**
   * Fills `reach` down from the root when the root has none: a table made before the column. One
   * transaction, so the root's reach is set exactly when every node's is; until then nothing is
   * reachable but by administrators. Nodes no path from the root reaches keep none.
   */
  private async fillReach(): Promise<void> {
    const root = await this.runParameterized({ text: `SELECT reach FROM ${this.nodesTable} WHERE id = $1`, values: [this.rootId] });
    if (root[0]?.reach !== null) return;
    const tx = await this.beginTransaction() as PgTransaction;
    try {
      const started = Date.now();
      const written = await refreshReach(this.reachGraph(tx, false), [this.rootId]);
      await tx.commit();
      logger.info('reach filled', { table: this.nodesTable, nodes: written, ms: Date.now() - started });
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  /** Refreshes the reach of the children of `ids` and below, in `tx`. */
  private async refreshBelow(tx: PgTransaction, ids: NodeId[]): Promise<void> {
    if (ids.length === 0) return;
    const graph = this.reachGraph(tx, true);
    await refreshReach(graph, await graph.children(ids));
  }

  /** Share-locks `parentId` for a write that gives a node under it its reach; see _Reach_. */
  private async lockParent(tx: PgTransaction, parentId: NodeId): Promise<ReachRow['parents'][number] | undefined> {
    await this.useClasses(tx);
    const rows = await this.runParameterized({
      text: `SELECT reach, mode, uid, gid, acl FROM ${this.nodesTable} WHERE id = $1 FOR SHARE`,
      values: [parentId],
    }, tx);
    return rows[0] ? { reach: rows[0].reach as number | null, ownership: rowOwnership(rows[0]) } : undefined;
  }

  /** `refreshReach`'s reads and writes in `tx`; `lock` takes the rows it computes first (see _Reach_). */
  private reachGraph(tx: PgTransaction, lock: boolean): ReachGraph {
    return {
      rootId: this.rootId,
      classes: this.classes,
      rows: async (ids) => {
        await this.useClasses(tx);
        if (lock) await tx.client.query(`SELECT 1 FROM ${this.nodesTable} WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE`, [ids]);
        const rows = await this.runParameterized({
          text: `
            SELECT c.id, c.reach, p.id AS p_id, p.reach AS p_reach, p.mode AS p_mode, p.uid AS p_uid, p.gid AS p_gid, p.acl AS p_acl
            FROM ${this.nodesTable} c
            LEFT JOIN ${this.hierarchyTable} h ON h.child_id = c.id
            LEFT JOIN ${this.nodesTable} p ON p.id = h.parent_id
            WHERE c.id = ANY($1)
          `,
          values: [ids],
        }, tx);
        const result = new Map<NodeId, ReachRow>();
        for (const row of rows) {
          const id = row.id as NodeId;
          let entry = result.get(id);
          if (!entry) result.set(id, entry = { reach: row.reach as number | null, parents: [] });
          if (row.p_id !== null) entry.parents.push({ reach: row.p_reach as number | null, ownership: rowOwnership(row, 'p_') });
        }
        return result;
      },
      children: async (ids) => {
        const children = new Set<NodeId>();
        for (let start = 0; start < ids.length; start += CHILDREN_BATCH) {
          const rows = await tx.client.query<{ child_id: NodeId }>(
            `SELECT DISTINCT child_id FROM ${this.hierarchyTable} WHERE parent_id = ANY($1)`,
            [ids.slice(start, start + CHILDREN_BATCH)],
          );
          for (const row of rows.rows) children.add(row.child_id);
        }
        return [...children];
      },
      write: async (reaches) => {
        await tx.client.query(
          `UPDATE ${this.nodesTable} n SET reach = v.reach FROM unnest($1::varchar[], $2::int[]) AS v(id, reach) WHERE n.id = v.id`,
          [[...reaches.keys()], [...reaches.values()]],
        );
      },
    };
  }

  /**
   * One statement over the whole table, then the reach below every node that now lets others
   * through, in one transaction. The join with the rows as they were is what tells an owned node
   * from one whose ACL named the id: `RETURNING` sees only the new values.
   *
   * Afterwards no node's reach may name the id: whoever is given it next would be let through.
   * The transaction is rolled back if one does.
   */
  async releaseOwner(release: OwnerRelease, changeUid: UserId): Promise<ReleasedOwner> {
    // A column name, from the closed union — never caller text.
    const column = release.kind;
    const sql: SqlQuery = {
      text: `
        UPDATE ${this.nodesTable} n SET
          ${column} = CASE WHEN was.owned THEN $2 ELSE n.${column} END,
          acl = CASE WHEN was.granted
            THEN (SELECT jsonb_agg(entry) FROM jsonb_array_elements(n.acl) entry WHERE NOT entry @> $4::jsonb)
            ELSE n.acl END,
          change_uid = $5,
          change_time = now()
        FROM (
          SELECT id, mode, uid, gid, acl, ${column} = $1 AS owned, coalesce(acl @> $3::jsonb, false) AS granted
          FROM ${this.nodesTable}
          WHERE ${column} = $1 OR acl @> $3::jsonb
        ) was
        WHERE n.id = was.id
        RETURNING n.id, was.owned, was.granted, n.mode, n.uid, n.gid, n.acl,
          was.mode AS was_mode, was.uid AS was_uid, was.gid AS was_gid, was.acl AS was_acl
      `,
      values: [release.id, release.to, JSON.stringify([{ [column]: release.id }]), JSON.stringify({ [column]: release.id }), changeUid],
    };

    const released: ReleasedOwner = { owned: 0, acl: 0 };
    const tx = await this.beginTransaction() as PgTransaction;
    try {
      const rows = await this.runParameterized(sql, tx);
      await this.refreshBelow(tx, this.regranted(rows));
      await this.learnClasses(tx);
      const naming = [...this.classes.entries()].filter(([, formula]) => reachNamed(formula)[`${release.kind}s`].includes(release.id)).map(([id]) => id);
      if (naming.length > 0) {
        const left = await this.runParameterized({ text: `SELECT id FROM ${this.nodesTable} WHERE reach = ANY($1) LIMIT 1`, values: [naming] }, tx);
        if (left.length > 0) throw new Error(`node ${left[0].id} is still reached by ${release.kind} ${release.id} after its release`);
      }
      await tx.commit();
      for (const row of rows) {
        this.paths.dropNode(row.id as NodeId);
        if (row.owned) released.owned++;
        if (row.granted) released.acl++;
      }
    } catch (error) {
      if (tx.active) await tx.rollback();
      throw error;
    }
    return released;
  }

  /** Backlink lookup, served by the partial `C`-collated index on `softlink`. */
  async findSoftlinks(targets: NodePath[], limit: number, tx?: Transaction): Promise<Node[]> {
    if (targets.length === 0 || limit <= 0) return [];

    const sql: SqlQuery = {
      text: `
        SELECT ${LINK_COLUMNS}
        FROM ${this.nodesTable} n
        LEFT JOIN ${this.attrsTable} a ON a.node_id = n.id
        WHERE n.softlink COLLATE "C" = ANY($1::text[]) AND n.softlink IS NOT NULL
        LIMIT $2
      `,
      values: [[...new Set(targets)], limit],
    };

    return (await this.runParameterized(sql, tx)).map((row) => this.rowToNode(row));
  }

  /**
   * The links at each path, and those in its byte range `[path/, path0)`: one index probe and one
   * range scan per path, so the cost follows the links found, not the table. Each range is its own
   * lateral subquery, fenced with `OFFSET 0`: as a join, the planner guesses a handful of ranges
   * and filters every link against each one. The ids are gathered into an array first: the
   * planner cannot estimate a range per parameter, and given the ids as a subquery it reads every
   * node row to hash-join them.
   */
  async findSoftlinksUnder(paths: NodePath[], limit: number, tx?: Transaction): Promise<Node[]> {
    if (paths.length === 0 || limit <= 0) return [];

    const exact = [...new Set(paths)];
    const prefixes = exact.map((path) => (path.endsWith('/') ? path : `${path}/`));
    const sql: SqlQuery = {
      text: `
        SELECT ${LINK_COLUMNS}
        FROM ${this.nodesTable} n
        LEFT JOIN ${this.attrsTable} a ON a.node_id = n.id
        WHERE n.id = ANY(ARRAY(
          SELECT l.id FROM ${this.nodesTable} l
          WHERE l.softlink COLLATE "C" = ANY($1::text[]) AND l.softlink IS NOT NULL
          UNION
          SELECT under.id FROM unnest($2::text[], $3::text[]) AS r(lo, hi)
          CROSS JOIN LATERAL (
            SELECT l.id FROM ${this.nodesTable} l
            WHERE l.softlink COLLATE "C" >= r.lo AND l.softlink COLLATE "C" < r.hi AND l.softlink IS NOT NULL
            OFFSET 0
          ) under
        ))
        LIMIT $4
        ${tx ? 'FOR UPDATE OF n' : ''}
      `,
      values: [exact, prefixes, prefixes.map((prefix) => prefixUpperBound(prefix)!), limit],
    };

    return (await this.runParameterized(sql, tx)).map((row) => this.rowToNode(row));
  }

  private async runParameterized(sql: SqlQuery, tx?: Transaction): Promise<Record<string, unknown>[]> {
    if (tx) {
      const pgTx = tx as PgTransaction;
      if (!pgTx.active) {
        throw new NodeTransactionError('Transaction is not active');
      }
      const result = await pgTx.client.query<Record<string, unknown>>(sql.text, sql.values);
      return result.rows;
    }

    const conn = await this.pool.connect();
    try {
      const result = await conn.query<Record<string, unknown>>(sql.text, sql.values);
      return result.rows;
    } finally {
      conn.release();
    }
  }

  // ===== Helper: Convert DB row to Node =====

  private rowToNode<T extends NodeAttrs = NodeAttrs>(row: Record<string, unknown>): Node<T> {
    return {
      id: row.id as NodeId,
      type: row.type as NodeType,
      props: {
        mode: row.mode as Mode,
        uid: row.uid as UserId,
        gid: row.gid as GroupId,
        acl: row.acl as Array<Ownership> | undefined,
        // extract(epoch …) returns numeric, which the pg driver serializes as a
        // string; coerce to a real number (as with link_count below). A timestamp
        // column keeps microseconds, so a time set by `now()` reads back with a
        // fraction of a millisecond, which epoch milliseconds never carry.
        birthtime: {
          uid: row.birth_uid as number,
          timestamp: Math.round(Number(row.birth_time)),
        },
        changetime: {
          uid: row.change_uid as UserId,
          timestamp: Math.round(Number(row.change_time)),
        },
        modtime: {
          uid: row.mod_uid as UserId,
          timestamp: Math.round(Number(row.mod_time)),
        },
        // COUNT(*) is bigint, which the driver serializes as a string
        count: Number(row.link_count) || 0,
        softlink: row.softlink ? row.softlink as string : undefined,
        tier: row.tier ? row.tier as FileTier : undefined,
      },
      attrs: (row.attributes as T) || ({} as T),
    };
  }

  // ===== Core Read Operations =====

  /**
   * A node read touches the hierarchy only for its *link count* — a handful of
   * rows on the `child_id` index. It does not aggregate the node's children,
   * which would make every read proportional to the directory's size; callers
   * that want them ask via `getChildLinks`/`getChildren`.
   */
  private getNodeQuery(id: NodeId, forUpdate: boolean): SqlQuery {
    return this.nodesQuery('n.id = $1', [id], forUpdate);
  }

  /** Whole nodes, link count included, for the rows `where` picks out of `n`. */
  private nodesQuery(where: string, values: unknown[], forUpdate: boolean): SqlQuery {
    const text = `
      SELECT
        n.*,
        a.attributes,
        COALESCE(l.link_count, 0) AS link_count,
        extract(epoch FROM birth_time) * 1000 AS birth_time,
        extract(epoch FROM change_time) * 1000 AS change_time,
        extract(epoch FROM mod_time) * 1000 AS mod_time
      FROM ${this.nodesTable} n
      LEFT JOIN ${this.attrsTable} a
        ON a.node_id = n.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS link_count
        FROM ${this.hierarchyTable} h
        WHERE h.child_id = n.id
      ) l ON true
      WHERE ${where}
      ${forUpdate ? 'FOR UPDATE OF n' : ''};
    `;
    return { text, values };
  }

  async getNode<T extends NodeAttrs = NodeAttrs>(id: NodeId, tx?: Transaction): Promise<Node<T>> {
    const rows = await this.runParameterized(this.getNodeQuery(id, !!tx), tx);

    if (rows.length === 0) {
      throw new NodeNotFoundError(id);
    }

    return this.rowToNode<T>(rows[0]);
  }

  /**
   * A directory in one query: every child node, its name under this parent, and
   * its own child count. The last is a plain COUNT over the `(parent_id, …)`
   * index — enough to answer "is it empty?" without shipping the list. A page
   * (`opts.page`) is in name order from `after`, which the `(parent_id, name)`
   * primary key serves in the column's collation; a whole listing is in
   * `(position, name)` order.
   */
  private getChildrenQuery(parentId: NodeId, opts?: ChildLinkFilter): SqlQuery {
    const values: unknown[] = [parentId];
    const where = [`h.parent_id = $1`];

    if (opts?.name !== undefined) {
      values.push(opts.name);
      where.push(`h.name = $${values.length}`);
    }
    if (opts?.types !== undefined) {
      values.push(opts.types);
      where.push(`n.type = ANY($${values.length})`);
    }

    if (!opts?.page) return this.childEntriesQuery(where, values, 'h.position, h.name');

    if (opts.page.after !== undefined) {
      values.push(opts.page.after);
      where.push(`h.name > $${values.length}`);
    }
    values.push(opts.page.limit);
    return this.childEntriesQuery(where, values, `h.name LIMIT $${values.length}`);
  }

  /** Child entries — the node, its name and position under the parent, its own child count — for the edges `where` picks out of `h`. */
  private childEntriesQuery(where: string[], values: unknown[], orderBy: string): SqlQuery {
    return {
      text: `
        SELECT
          n.*,
          a.attributes,
          h.parent_id AS link_parent,
          h.name AS link_name,
          h.position AS link_position,
          COALESCE(l.link_count, 0) AS link_count,
          COALESCE(c.child_count, 0) AS child_count,
          extract(epoch FROM birth_time) * 1000 AS birth_time,
          extract(epoch FROM change_time) * 1000 AS change_time,
          extract(epoch FROM mod_time) * 1000 AS mod_time
        FROM ${this.hierarchyTable} h
        JOIN ${this.nodesTable} n
          ON n.id = h.child_id
        LEFT JOIN ${this.attrsTable} a
          ON a.node_id = n.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS link_count
          FROM ${this.hierarchyTable} h2
          WHERE h2.child_id = n.id
        ) l ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS child_count
          FROM ${this.hierarchyTable} h3
          WHERE h3.parent_id = n.id
        ) c ON true
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy};
      `,
      values,
    };
  }

  private rowToChildEntry<T extends NodeAttrs>(row: Record<string, unknown>): NodeChildEntry<T> {
    return {
      node: this.rowToNode<T>(row),
      name: row.link_name as string,
      position: row.link_position as number,
      childCount: Number(row.child_count) || 0,
    };
  }

  /**
   * Walk a path down from `fromId` in one recursive descent of the hierarchy, or
   * from memory when every step of it is in `paths`.
   *
   * The mirror of {@link resolvePaths}, which walks up. Both exist because the
   * hierarchy is `(parent_id, name)`-keyed, so a whole path is one indexed
   * traversal — while doing it in the caller costs a round trip per segment,
   * paid by every VFS operation before it does any work of its own.
   *
   * `PRIMARY KEY (parent_id, name)` is what makes the recursion safe: a name is
   * unique within a parent, so each depth matches at most one row and the walk
   * cannot fan out. It stops naturally wherever the hierarchy does — at a
   * missing segment, at a softlink, or at a mount point whose children live in
   * another store — and returning a short chain is the contract, not a failure.
   *
   * Only what a walk checks is read: the access columns and `softlink`, with no
   * attrs, timestamps or link count. The name at each depth is the segment that
   * matched it. Inside a transaction the cache is neither read nor filled, as the
   * transaction may see writes of its own that nobody else can yet.
   */
  async resolveChain(
    fromId: NodeId,
    segments: string[],
    tx?: Transaction,
  ): Promise<ResolvedNodeChain> {
    if (!tx) {
      const cached = this.paths.chain(fromId, segments);
      if (cached) return cached;
    }

    const version = this.paths.version;
    const sql: SqlQuery = {
      text: `
        WITH RECURSIVE walk AS (
          SELECT $1::varchar(26) AS node_id, 0 AS depth
          UNION ALL
          SELECT h.child_id, w.depth + 1
          FROM walk w
          JOIN ${this.hierarchyTable} h
            ON h.parent_id = w.node_id
           AND h.name = ($2::text[])[w.depth + 1]
          WHERE w.depth < array_length($2::text[], 1)
        )
        SELECT n.id, n.mode, n.uid, n.gid, n.acl, n.softlink, w.depth AS walk_depth
        FROM walk w
        JOIN ${this.nodesTable} n
          ON n.id = w.node_id
        ORDER BY w.depth;
      `,
      values: [fromId, segments],
    };

    const rows = await this.runParameterized(sql, tx);

    // Trust only an unbroken prefix. A gap should be impossible given the
    // recursion, but a chain with a hole would silently skip a permission check
    // in the caller, so stop at the first discontinuity rather than assume.
    const rootRow = rows[0];
    if (!rootRow || Number(rootRow.walk_depth) !== 0) {
      throw new NodeNotFoundError(fromId);
    }

    const entries: PathEntry[] = [];
    for (const row of rows.slice(1)) {
      if (Number(row.walk_depth) !== entries.length + 1) break;
      entries.push({ ...this.rowToPathNode(row), name: segments[entries.length] });
    }

    const chain = { root: this.rowToPathNode(rootRow), entries };
    if (!tx) this.paths.fill(version, fromId, segments, chain);
    return chain;
  }

  private rowToPathNode(row: Record<string, unknown>): PathNode {
    return {
      id: row.id as NodeId,
      props: {
        mode: row.mode as Mode,
        uid: row.uid as UserId,
        gid: row.gid as GroupId,
        ...(row.acl ? { acl: row.acl as ModeACL[] } : {}),
        softlink: row.softlink ? row.softlink as string : undefined,
      },
    };
  }

  async getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]> {
    const rows = await this.runParameterized(this.getChildrenQuery(parentId, opts), tx);

    return rows.map((row) => this.rowToChildEntry<T>(row));
  }

  /** Every parent's listing in one query, as `getChildren` lists one. */
  async getChildrenMany<T extends NodeAttrs = NodeAttrs>(
    parentIds: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, NodeChildEntry<T>[]>> {
    const result = new Map<NodeId, NodeChildEntry<T>[]>();
    if (parentIds.length === 0) return result;

    const sql = this.childEntriesQuery([`h.parent_id = ANY($1)`], [[...new Set(parentIds)]], 'h.parent_id, h.position, h.name');

    for (const row of await this.runParameterized(sql, tx)) {
      const parentId = row.link_parent as NodeId;
      const listing = result.get(parentId) ?? [];
      listing.push(this.rowToChildEntry<T>(row));
      result.set(parentId, listing);
    }

    return result;
  }

  private childLinkQuery(parentIds: NodeId[], opts?: ChildLinkFilter): SqlQuery {
    const values: unknown[] = [parentIds];
    const where = [`parent_id = ANY($1)`];

    if (opts?.name !== undefined) {
      values.push(opts.name);
      where.push(`name = $${values.length}`);
    }
    if (opts?.childId !== undefined) {
      values.push(opts.childId);
      where.push(`child_id = $${values.length}`);
    }

    return {
      text: `
        SELECT parent_id, child_id, name, position
        FROM ${this.hierarchyTable}
        WHERE ${where.join(' AND ')}
        ORDER BY parent_id, position, name
      `,
      values,
    };
  }

  async getChildLinks(parentId: NodeId, opts?: ChildLinkFilter, tx?: Transaction): Promise<NodeChild[]> {
    const rows = await this.runParameterized(this.childLinkQuery([parentId], opts), tx);

    return rows.map((row) => ({
      id: row.child_id as NodeId,
      name: row.name as string,
      position: row.position as number,
    }));
  }

  /** One join of the pairs against the `(parent_id, name)` primary key. */
  async findChildLinks(edges: ParentLink[], tx?: Transaction): Promise<(ParentLink & { id: NodeId })[]> {
    if (edges.length === 0) return [];

    const rows = await this.runParameterized({
      text: `
        SELECT h.parent_id, h.name, h.child_id
        FROM unnest($1::varchar[], $2::varchar[]) AS k(parent_id, name)
        JOIN ${this.hierarchyTable} h ON h.parent_id = k.parent_id AND h.name = k.name
      `,
      values: [edges.map((edge) => edge.parentId), edges.map((edge) => edge.name)],
    }, tx);

    return rows.map((row) => ({ parentId: row.parent_id as NodeId, name: row.name as string, id: row.child_id as NodeId }));
  }

  async getChildLinksMany(parentIds: NodeId[], tx?: Transaction): Promise<Map<NodeId, NodeChild[]>> {
    const result = new Map<NodeId, NodeChild[]>();
    if (parentIds.length === 0) return result;

    const rows = await this.runParameterized(this.childLinkQuery([...new Set(parentIds)]), tx);

    for (const row of rows) {
      const parentId = row.parent_id as NodeId;
      const links = result.get(parentId) ?? [];
      links.push({
        id: row.child_id as NodeId,
        name: row.name as string,
        position: row.position as number,
      });
      result.set(parentId, links);
    }

    return result;
  }

  async countChildren(parentId: NodeId, tx?: Transaction): Promise<number> {
    const rows = await this.runParameterized({
      text: `SELECT COUNT(*) AS count FROM ${this.hierarchyTable} WHERE parent_id = $1`,
      values: [parentId],
    }, tx);

    return Number(rows[0]?.count) || 0;
  }

  async countReadableChildren(reader: Access, parentIds: NodeId[], tx?: Transaction): Promise<Map<NodeId, number>> {
    const result = new Map<NodeId, number>();
    if (parentIds.length === 0) return result;

    const params = new ParamList();
    const parents = params.bind([...new Set(parentIds)]);
    const rows = await this.runParameterized({
      text: `
        SELECT h.parent_id, COUNT(*) AS count
        FROM ${this.hierarchyTable} h
        JOIN ${this.nodesTable} n ON n.id = h.child_id
        WHERE h.parent_id = ANY(${parents}) AND ${readsSql('n', reader, params)}
        GROUP BY h.parent_id
      `,
      values: params.values,
    }, tx);

    for (const row of rows) result.set(row.parent_id as NodeId, Number(row.count));
    return result;
  }

  private getParentsQuery(childId: NodeId): SqlQuery {
    const text = `
      SELECT
        n.*,
        a.attributes,
        COALESCE(l.link_count, 0) AS link_count,
        extract(epoch FROM birth_time) * 1000 AS birth_time,
        extract(epoch FROM change_time) * 1000 AS change_time,
        extract(epoch FROM mod_time) * 1000 AS mod_time
      FROM ${this.nodesTable} n
      LEFT JOIN ${this.attrsTable} a
        ON a.node_id = n.id
      JOIN ${this.hierarchyTable} h
        ON h.parent_id = n.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS link_count
        FROM ${this.hierarchyTable} h2
        WHERE h2.child_id = n.id
      ) l ON true
      WHERE h.child_id = $1;
    `;
    return { text, values: [childId] };
  }

  async getParents<T extends NodeAttrs = NodeAttrs>(childId: NodeId, tx?: Transaction): Promise<Node<T>[]> {
    const rows = await this.runParameterized(this.getParentsQuery(childId), tx);
    return rows.map((row) => this.rowToNode<T>(row));
  }

  async exists(id: NodeId, tx?: Transaction): Promise<boolean> {
    const query = `SELECT EXISTS(SELECT 1 FROM ${this.nodesTable} WHERE id = $1) as exists`;

    if (tx) {
      const pgTx = tx as PgTransaction;
      if (!pgTx.active) {
        throw new NodeTransactionError('Transaction is not active');
      }

      const result = await pgTx.client.query<{ exists: boolean }>(query, [id]);
      return result.rows[0]?.exists || false;
    }

    const conn = await this.pool.connect();
    try {
      const result = await conn.query<{ exists: boolean }>(query, [id]);
      return result.rows[0]?.exists || false;
    } finally {
      conn.release();
    }
  }

  // ===== Write Operations =====

  /**
   * The node, its attrs and the edge naming it under `parentId`, in one
   * statement. A CTE's data-modifying arms all run to completion in the same
   * statement, so the two foreign keys pointing back at the new node are
   * satisfied without a round trip between them.
   *
   * The collision check is the `(parent_id, name)` primary key rather than a
   * preceding SELECT: the index has to be consulted for the insert anyway, and
   * asking it twice would only widen the window in which the answer can change.
   */
  async createNode<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    type: NodeType,
    parentId: NodeId,
    name: string,
    props: NodePropsCreate,
    attrs?: T,
    tx?: Transaction,
  ): Promise<Node<T>> {
    if (!parentId) {
      throw new Error('parent ID is required');
    }

    const pgTx = this.requireTx(tx, 'createNode');
    const parent = await this.lockParent(pgTx, parentId);
    if (!parent) throw new NodeNotFoundError(parentId);
    const reach = await this.classes.under(parent);

    const nodeId = ulid();
    const now = Date.now();
    const birthUid = props.birthtime?.uid ?? uid;
    const birthTime = props.birthtime?.timestamp ?? now;

    // birth_uid/birth_time may be preserved (import) via props.birthtime;
    // change/mod always stamp the current create.
    //
    // The parent id is passed twice on purpose: reusing $14 inside the position
    // subquery leaves its type ambiguous to the planner ("inconsistent types
    // deduced").
    try {
      await pgTx.client.query(
        `WITH inserted AS (
           INSERT INTO ${this.nodesTable} (
             id, type, mode, uid, gid, acl,
             birth_uid, birth_time, change_uid, change_time, mod_uid, mod_time, softlink, tier, reach
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, to_timestamp($8 / 1000.0), $9, to_timestamp($10 / 1000.0), $9, to_timestamp($10 / 1000.0), $11, $12, $17
           )
           RETURNING id, type
         ),
         attrs AS (
           INSERT INTO ${this.attrsTable} (node_id, node_type, attributes)
           SELECT id, type, $13 FROM inserted
         )
         INSERT INTO ${this.hierarchyTable} (parent_id, child_id, name, position)
         SELECT $14, inserted.id, $15, (
           SELECT COALESCE(MAX(position), 0) + 1
           FROM ${this.hierarchyTable}
           WHERE parent_id = $16::varchar
         )
         FROM inserted`,
        [
          nodeId,
          type,
          props.mode ?? 0o755,
          props.uid ?? uid,
          props.gid ?? 0,
          props.acl ? JSON.stringify(props.acl) : null,
          birthUid,
          birthTime,
          uid,
          now,
          props.softlink,
          props.tier ?? null,
          JSON.stringify(attrs || {}),
          parentId,
          name,
          parentId,
          reach,
        ],
      );
    } catch (error) {
      throw this.hierarchyWriteError(error, parentId, name);
    }
    pgTx.onEnd(() => this.paths.dropEdge(parentId, name));

    return {
      id: nodeId,
      type,
      props: {
        mode: props.mode ?? 0o755,
        uid: props.uid ?? uid,
        gid: props.gid ?? 0,
        acl: props.acl,
        birthtime: { uid: birthUid, timestamp: birthTime },
        changetime: { uid, timestamp: now },
        modtime: { uid, timestamp: now },
        // The edge above is this node's only one.
        count: 1,
        softlink: props.softlink,
        tier: props.tier,
      },
      attrs: attrs || ({} as T),
    };
  }

  /**
   * One INSERT for every child: the nodes, their attrs and their edges, each edge at the tail of
   * the parent in the order given, as `createNode` puts one there.
   */
  async createNodes<T extends NodeAttrs = NodeAttrs>(uid: UserId, parentId: NodeId, children: NewChild<T>[], tx?: Transaction): Promise<Node<T>[]> {
    const pgTx = this.requireTx(tx, 'createNodes');
    if (children.length === 0) return [];
    const parent = await this.lockParent(pgTx, parentId);
    if (!parent) throw new NodeNotFoundError(parentId);
    const reach = await this.classes.under(parent);

    const now = Date.now();
    const rows = children.map(({ type, name, props, attrs }, i) => ({
      id: ulid(),
      ord: i + 1,
      type,
      name,
      mode: props.mode ?? 0o755,
      uid: props.uid ?? uid,
      gid: props.gid ?? 0,
      acl: props.acl ?? null,
      birth_uid: props.birthtime?.uid ?? uid,
      birth_time: props.birthtime?.timestamp ?? now,
      softlink: props.softlink ?? null,
      tier: props.tier ?? null,
      attributes: attrs || {},
    }));

    try {
      await pgTx.client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
             id text, type text, name text, mode integer, uid integer, gid integer, acl jsonb,
             birth_uid integer, birth_time double precision, softlink text, tier text, attributes jsonb, ord integer
           )
         ),
         inserted AS (
           INSERT INTO ${this.nodesTable} (
             id, type, mode, uid, gid, acl,
             birth_uid, birth_time, change_uid, change_time, mod_uid, mod_time, softlink, tier, reach
           )
           SELECT id, type, mode, uid, gid, acl,
             birth_uid, to_timestamp(birth_time / 1000.0), $2, to_timestamp($3 / 1000.0), $2, to_timestamp($3 / 1000.0), softlink, tier, $6
           FROM input
           RETURNING id
         ),
         attrs AS (
           INSERT INTO ${this.attrsTable} (node_id, node_type, attributes)
           SELECT input.id, input.type, input.attributes FROM inserted JOIN input ON input.id = inserted.id
         )
         INSERT INTO ${this.hierarchyTable} (parent_id, child_id, name, position)
         SELECT $4, input.id, input.name, tail.top + input.ord
         FROM inserted
         JOIN input ON input.id = inserted.id
         CROSS JOIN (SELECT COALESCE(MAX(position), 0) AS top FROM ${this.hierarchyTable} WHERE parent_id = $5::varchar) tail`,
        [JSON.stringify(rows), uid, now, parentId, parentId, reach],
      );
    } catch (error) {
      // The constraint names the edge it refused; the error is about that child.
      const detail = String((error as { detail?: string } | null)?.detail ?? '');
      const taken = children.find((child) => detail.includes(`(${parentId}, ${child.name})`)) ?? children[0];
      throw this.hierarchyWriteError(error, parentId, taken.name);
    }
    pgTx.onEnd(() => {
      for (const child of children) this.paths.dropEdge(parentId, child.name);
    });

    return rows.map((row, i) => ({
      id: row.id,
      type: row.type,
      props: {
        mode: row.mode,
        uid: row.uid,
        gid: row.gid,
        acl: children[i].props.acl,
        birthtime: { uid: row.birth_uid, timestamp: row.birth_time },
        changetime: { uid, timestamp: now },
        modtime: { uid, timestamp: now },
        count: 1,
        softlink: children[i].props.softlink,
        tier: children[i].props.tier,
      },
      attrs: (children[i].attrs || {}) as T,
    }));
  }

  async updateNode<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    id: NodeId,
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    tx?: Transaction,
  ): Promise<Node<T>> {
    const node = (await this.updateNodes<T>(uid, [id], props, attrs, tx)).get(id);
    if (!node) {
      throw new NodeNotFoundError(id);
    }

    return node;
  }

  /**
   * Three statements whatever the number of nodes: the node columns, the attrs, and the rows read
   * back as written. A props change stamps `change_*`, an attrs change `mod_*`.
   */
  async updateNodes<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    ids: NodeId[],
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const pgTx = this.requireTx(tx, 'updateNodes');

    const result = new Map<NodeId, Node<T>>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return result;

    const now = Date.now();
    const values: unknown[] = [unique];
    const param = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };

    const columns: string[] = [];
    if (props?.mode !== undefined) columns.push(`mode = ${param(props.mode)}`);
    if (props?.uid !== undefined) columns.push(`uid = ${param(props.uid)}`);
    if (props?.gid !== undefined) columns.push(`gid = ${param(props.gid)}`);
    if (props?.acl !== undefined) columns.push(`acl = ${param(JSON.stringify(props.acl))}`);
    if (props?.softlink !== undefined) columns.push(`softlink = ${param(props.softlink)}`);
    if (props?.tier !== undefined) columns.push(`tier = ${param(props.tier)}`);

    const propsChanged = columns.length > 0;
    if (propsChanged) {
      columns.push(`change_uid = ${param(uid)}`, `change_time = to_timestamp(${param(now)}/1000.0)`);
    }
    if (attrs) {
      columns.push(`mod_uid = ${param(uid)}`, `mod_time = to_timestamp(${param(now)}/1000.0)`);
    }

    // The rows as they were, joined in, tell a node that now lets others through from one that
    // does not: `RETURNING` sees only the new values.
    const regrants = props?.mode !== undefined || props?.uid !== undefined || props?.gid !== undefined || props?.acl !== undefined;
    if (columns.length > 0) {
      const updated = await pgTx.client.query(
        regrants
          ? `UPDATE ${this.nodesTable} n
             SET ${columns.join(', ')}
             FROM (SELECT id, mode, uid, gid, acl FROM ${this.nodesTable} WHERE id = ANY($1)) was
             WHERE n.id = was.id
             RETURNING n.id, n.mode, n.uid, n.gid, n.acl, was.mode AS was_mode, was.uid AS was_uid, was.gid AS was_gid, was.acl AS was_acl`
          : `UPDATE ${this.nodesTable}
             SET ${columns.join(', ')}
             WHERE id = ANY($1)`,
        values,
      );
      if (regrants) await this.refreshBelow(pgTx, this.regranted(updated.rows));
    }

    // What a path walk reads of a node is its props.
    if (propsChanged) {
      pgTx.onEnd(() => {
        for (const id of unique) this.paths.dropNode(id);
      });
    }

    // `||` merges, so it can only ever add or overwrite keys —
    // a key left out is untouched, which is what makes this a patch. Removal therefore has
    // to be explicit: a null or undefined value means delete, and `- text[]` strips those
    // keys after the merge (see NodeAttrsUpdate). Undefined has to be caught here, as
    // JSON.stringify would otherwise drop it and leave the old value in place.
    if (attrs) {
      const entries = Object.entries(attrs);
      const removals = entries.filter(([, value]) => value === null || value === undefined).map(([key]) => key);
      const merges = Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined));

      await pgTx.client.query(
        `UPDATE ${this.attrsTable}
         SET attributes = (attributes || $1::jsonb) - $2::text[],
             node_type = COALESCE(node_type, (SELECT n.type FROM ${this.nodesTable} n WHERE n.id = ${this.attrsTable}.node_id))
         WHERE node_id = ANY($3)`,
        [JSON.stringify(merges), removals, unique],
      );
    }

    for (const row of await this.runParameterized(this.nodesQuery('n.id = ANY($1)', [unique], false), tx)) {
      const node = this.rowToNode<T>(row);
      result.set(node.id, node);
    }

    return result;
  }

  /**
   * Three statements whatever the number of nodes, as `updateNodes`: each node's columns and its
   * stamps, its attrs, and the rows read back. A change carries its props as JSON, so a prop it
   * leaves out keeps its value and one it gives is written as `updateNodes` writes it.
   */
  async updateNodesEach<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    changes: NodeUpdate<T>[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const pgTx = this.requireTx(tx, 'updateNodesEach');

    const result = new Map<NodeId, Node<T>>();
    if (changes.length === 0) return result;
    if (new Set(changes.map((change) => change.id)).size !== changes.length) {
      throw new NodeTransactionError('updateNodesEach: a node is changed twice');
    }

    // Undefined props drop out of the JSON, which is what leaves them as they are.
    const rows = changes.map((change) => {
      const props = JSON.parse(JSON.stringify(change.props ?? {})) as Record<string, unknown>;
      const attrs = change.attrs ? Object.entries(change.attrs) : undefined;
      return {
        id: change.id,
        p: props,
        changed: Object.keys(props).length > 0,
        a: attrs !== undefined,
        m: attrs ? Object.fromEntries(attrs.filter(([, value]) => value !== null && value !== undefined)) : {},
        r: attrs ? attrs.filter(([, value]) => value === null || value === undefined).map(([key]) => key) : [],
      };
    });
    const now = Date.now();

    const updated = await pgTx.client.query(
      `UPDATE ${this.nodesTable} n SET
         mode = CASE WHEN c.p ? 'mode' THEN (c.p->>'mode')::integer ELSE n.mode END,
         uid = CASE WHEN c.p ? 'uid' THEN (c.p->>'uid')::integer ELSE n.uid END,
         gid = CASE WHEN c.p ? 'gid' THEN (c.p->>'gid')::integer ELSE n.gid END,
         acl = CASE WHEN c.p ? 'acl' THEN c.p->'acl' ELSE n.acl END,
         softlink = CASE WHEN c.p ? 'softlink' THEN c.p->>'softlink' ELSE n.softlink END,
         tier = CASE WHEN c.p ? 'tier' THEN c.p->>'tier' ELSE n.tier END,
         change_uid = CASE WHEN c.changed THEN $2 ELSE n.change_uid END,
         change_time = CASE WHEN c.changed THEN to_timestamp($3/1000.0) ELSE n.change_time END,
         mod_uid = CASE WHEN c.a THEN $2 ELSE n.mod_uid END,
         mod_time = CASE WHEN c.a THEN to_timestamp($3/1000.0) ELSE n.mod_time END
       FROM jsonb_to_recordset($1::jsonb) AS c(id varchar, p jsonb, changed boolean, a boolean),
         ${this.nodesTable} was
       WHERE n.id = c.id AND was.id = c.id AND (c.changed OR c.a)
       RETURNING n.id, n.mode, n.uid, n.gid, n.acl, was.mode AS was_mode, was.uid AS was_uid, was.gid AS was_gid, was.acl AS was_acl`,
      [JSON.stringify(rows), uid, now],
    );
    await this.refreshBelow(pgTx, this.regranted(updated.rows));

    const changedProps = rows.filter((row) => row.changed).map((row) => row.id);
    if (changedProps.length > 0) {
      pgTx.onEnd(() => {
        for (const id of changedProps) this.paths.dropNode(id);
      });
    }

    // As `updateNodes`: merged with `||`, and the keys set to null or undefined stripped after.
    const attrRows = rows.filter((row) => row.a);
    if (attrRows.length > 0) {
      await pgTx.client.query(
        `UPDATE ${this.attrsTable} a
         SET attributes = (a.attributes || c.m) - ARRAY(SELECT jsonb_array_elements_text(c.r)),
             node_type = COALESCE(a.node_type, (SELECT n.type FROM ${this.nodesTable} n WHERE n.id = a.node_id))
         FROM jsonb_to_recordset($1::jsonb) AS c(id varchar, m jsonb, r jsonb)
         WHERE a.node_id = c.id`,
        [JSON.stringify(attrRows.map((row) => ({ id: row.id, m: row.m, r: row.r })))],
      );
    }

    const ids = rows.map((row) => row.id);
    for (const row of await this.runParameterized(this.nodesQuery('n.id = ANY($1)', [ids], false), tx)) {
      const node = this.rowToNode<T>(row);
      result.set(node.id, node);
    }

    return result;
  }

  /** Of rows read back with their access columns as they were (`was_`), the nodes now letting through others. */
  private regranted(rows: Record<string, unknown>[]): NodeId[] {
    return rows.filter((row) => passesChanged(rowOwnership(row, 'was_'), rowOwnership(row))).map((row) => row.id as NodeId);
  }

  // ===== Hierarchy Writes =====

  /**
   * Translate the constraint the `(parent_id, name)` primary key and the
   * `parent_id` foreign key raise into the VFS's own errors, so a caller that
   * lost a name race sees `NodeAlreadyExistsError` whether it checked first or
   * let the index answer.
   */
  private hierarchyWriteError(error: unknown, parentId: NodeId, name: string): unknown {
    const code = (error as { code?: string } | null)?.code;

    if (code === UNIQUE_VIOLATION) return new NodeAlreadyExistsError(parentId, name);
    if (code === FOREIGN_KEY_VIOLATION) return new NodeNotFoundError(parentId);

    return error;
  }

  /** The transaction every hierarchy write needs, validated. */
  private requireTx(tx: Transaction | undefined, op: string): PgTransaction {
    if (!tx) {
      throw new NodeTransactionError(`transaction is required for ${op}`);
    }

    const pgTx = tx as PgTransaction;
    if (!pgTx.active) {
      throw new NodeTransactionError('Transaction is not active');
    }

    return pgTx;
  }

  /**
   * One INSERT. `position` comes from the current tail so ordering is stable,
   * and it is read through the `(parent_id, position, name)` index rather than
   * by counting rows.
   */
  async linkChild(
    _uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    tx?: Transaction,
  ): Promise<void> {
    const pgTx = this.requireTx(tx, 'linkChild');
    if (!await this.lockParent(pgTx, parentId)) throw new NodeNotFoundError(parentId);

    // The parent id is passed twice on purpose: reusing $1 inside the subquery
    // leaves its type ambiguous to the planner ("inconsistent types deduced").
    try {
      await pgTx.client.query(
        `INSERT INTO ${this.hierarchyTable} (parent_id, child_id, name, position)
         VALUES ($1, $2, $3, (
           SELECT COALESCE(MAX(position), 0) + 1
           FROM ${this.hierarchyTable}
           WHERE parent_id = $4::varchar
         ))`,
        [parentId, childId, name, parentId],
      );
    } catch (error) {
      throw this.hierarchyWriteError(error, parentId, name);
    }
    pgTx.onEnd(() => this.paths.dropEdge(parentId, name));
    await refreshReach(this.reachGraph(pgTx, true), [childId]);
  }

  async unlinkChild(
    _uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    tx?: Transaction,
  ): Promise<void> {
    const pgTx = this.requireTx(tx, 'unlinkChild');

    await pgTx.client.query(
      `DELETE FROM ${this.hierarchyTable} WHERE parent_id = $1 AND child_id = $2 AND name = $3`,
      [parentId, childId, name],
    );
    pgTx.onEnd(() => this.paths.dropEdge(parentId, name));
    await refreshReach(this.reachGraph(pgTx, true), [childId]);
  }

  async moveChild(
    _uid: UserId,
    oldParentId: NodeId,
    oldName: string,
    newParentId: NodeId,
    newName: string,
    tx?: Transaction,
  ): Promise<void> {
    const pgTx = this.requireTx(tx, 'moveChild');
    const reparented = oldParentId !== newParentId;
    if (reparented && !await this.lockParent(pgTx, newParentId)) throw new NodeNotFoundError(newParentId);

    // Re-parenting puts the edge at the new parent's tail; an in-place rename
    // keeps its position, so a reordered directory survives a rename.
    const result = await pgTx.client.query<{ child_id: NodeId }>(
      `UPDATE ${this.hierarchyTable}
       SET parent_id = $3,
           name = $4,
           position = CASE WHEN parent_id = $5::varchar THEN position ELSE (
             SELECT COALESCE(MAX(position), 0) + 1
             FROM ${this.hierarchyTable}
             WHERE parent_id = $5::varchar
           ) END
       WHERE parent_id = $1 AND name = $2
       RETURNING child_id`,
      [oldParentId, oldName, newParentId, newName, newParentId],
    ).catch((error) => {
      throw this.hierarchyWriteError(error, newParentId, newName);
    });

    if ((result.rowCount ?? 0) === 0) {
      throw new NodeNotFoundError(`${oldName} in ${oldParentId}`);
    }
    pgTx.onEnd(() => {
      this.paths.dropEdge(oldParentId, oldName);
      this.paths.dropEdge(newParentId, newName);
    });
    if (reparented) await refreshReach(this.reachGraph(pgTx, true), result.rows.map((row) => row.child_id));
  }

  /** One DELETE for every edge. */
  async unlinkChildren(_uid: UserId, edges: (ParentLink & { id: NodeId })[], tx?: Transaction): Promise<void> {
    const pgTx = this.requireTx(tx, 'unlinkChildren');
    if (edges.length === 0) return;

    await pgTx.client.query(
      `DELETE FROM ${this.hierarchyTable} h
       USING unnest($1::varchar[], $2::varchar[], $3::varchar[]) AS k(parent_id, child_id, name)
       WHERE h.parent_id = k.parent_id AND h.child_id = k.child_id AND h.name = k.name`,
      [edges.map((edge) => edge.parentId), edges.map((edge) => edge.id), edges.map((edge) => edge.name)],
    );
    pgTx.onEnd(() => {
      for (const edge of edges) this.paths.dropEdge(edge.parentId, edge.name);
    });
    await refreshReach(this.reachGraph(pgTx, true), edges.map((edge) => edge.id));
  }

  /** One DELETE for every node; their attrs and edges go with them, as with `deleteNode`. */
  async deleteNodes(_uid: UserId, ids: NodeId[], tx?: Transaction): Promise<void> {
    const pgTx = this.requireTx(tx, 'deleteNodes');
    if (ids.length === 0) return;

    await this.deleteRows(pgTx, ids);
    pgTx.onEnd(() => {
      for (const id of ids) this.paths.dropNode(id);
    });
  }

  /**
   * Deletes the rows of `ids`; their attrs and edges go with them (ON DELETE CASCADE). A child
   * left behind under another parent has lost one of its parents, and its reach is refreshed.
   */
  private async deleteRows(pgTx: PgTransaction, ids: NodeId[]): Promise<number> {
    const orphaned = await pgTx.client.query<{ child_id: NodeId }>(
      `SELECT DISTINCT child_id FROM ${this.hierarchyTable} WHERE parent_id = ANY($1) AND child_id <> ALL($1)`,
      [ids],
    );
    const result = await pgTx.client.query(`DELETE FROM ${this.nodesTable} WHERE id = ANY($1)`, [ids]);
    await refreshReach(this.reachGraph(pgTx, true), orphaned.rows.map((row) => row.child_id));
    return result.rowCount ?? 0;
  }

  /**
   * One UPDATE for every edge: a re-parented edge goes to the tail of its new parent, in the order
   * given, and one renamed in place keeps its position, as `moveChild` does.
   */
  async moveChildren(_uid: UserId, moves: EdgeMove[], tx?: Transaction): Promise<void> {
    const pgTx = this.requireTx(tx, 'moveChildren');
    if (moves.length === 0) return;
    const parents = [...new Set(moves.filter((move) => move.from.parentId !== move.to.parentId).map((move) => move.to.parentId))].sort();
    for (const parentId of parents) if (!await this.lockParent(pgTx, parentId)) throw new NodeNotFoundError(parentId);

    const result = await pgTx.client.query<{ child_id: NodeId; reparented: boolean }>(
      `WITH m AS (
         SELECT k.*, row_number() OVER (PARTITION BY k.new_parent ORDER BY k.ord) AS rank
         FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[])
           WITH ORDINALITY AS k(old_parent, old_name, new_parent, new_name, ord)
       ), tail AS (
         SELECT t.new_parent,
           COALESCE((SELECT MAX(h.position) FROM ${this.hierarchyTable} h WHERE h.parent_id = t.new_parent), 0) AS top
         FROM (SELECT DISTINCT new_parent FROM m) t
       )
       UPDATE ${this.hierarchyTable} h
       SET parent_id = m.new_parent,
           name = m.new_name,
           position = CASE WHEN h.parent_id = m.new_parent THEN h.position ELSE tail.top + m.rank END
       FROM m JOIN tail ON tail.new_parent = m.new_parent
       WHERE h.parent_id = m.old_parent AND h.name = m.old_name
       RETURNING h.child_id, m.old_parent <> m.new_parent AS reparented`,
      [
        moves.map((move) => move.from.parentId),
        moves.map((move) => move.from.name),
        moves.map((move) => move.to.parentId),
        moves.map((move) => move.to.name),
      ],
    ).catch((error) => {
      // The constraint names the edge it refused; the error is about that move.
      const detail = String((error as { detail?: string } | null)?.detail ?? '');
      const taken = moves.find((move) => detail.includes(`(${move.to.parentId}, ${move.to.name})`)) ?? moves[0];
      throw this.hierarchyWriteError(error, taken.to.parentId, taken.to.name);
    });

    pgTx.onEnd(() => {
      for (const { from, to } of moves) {
        this.paths.dropEdge(from.parentId, from.name);
        this.paths.dropEdge(to.parentId, to.name);
      }
    });

    if ((result.rowCount ?? 0) !== moves.length) {
      throw new NodeNotFoundError(`${moves.length - (result.rowCount ?? 0)} of ${moves.length} edges to move`);
    }
    await refreshReach(this.reachGraph(pgTx, true), result.rows.filter((row) => row.reparented).map((row) => row.child_id));
  }

  async deleteNode(
    _uid: UserId,
    id: NodeId,
    tx?: Transaction,
  ): Promise<boolean> {
    if (!tx) {
      throw new NodeTransactionError('Transaction is required for deleteNode');
    }

    const pgTx = tx as PgTransaction;
    if (!pgTx.active) {
      throw new NodeTransactionError('Transaction is not active');
    }

    // An edge to it left in `paths` answers nothing once its props are gone.
    const deleted = await this.deleteRows(pgTx, [id]);
    pgTx.onEnd(() => this.paths.dropNode(id));

    return deleted > 0;
  }

  // ===== Audit Trail =====

  readonly auditing = true;

  async appendAudit(records: AuditRecord[], tx?: Transaction): Promise<void> {
    if (records.length === 0) return;

    // One statement for the whole mutation, however many nodes it wrote.
    const rows = records.map((r) => ({
      id: r.id,
      at: r.timestamp,
      uid: r.uid,
      sid: r.sid ?? null,
      cause: r.cause ?? null,
      op: r.op,
      node_id: r.nodeId,
      node_type: r.nodeType,
      path: r.path,
      from_path: r.fromPath ?? null,
      attrs: r.attrs ?? null,
      props: r.props ?? null,
    }));

    await this.runParameterized({
      text: `
        INSERT INTO ${this.auditTable} (id, at, uid, sid, cause, op, node_id, node_type, path, from_path, attrs, props)
        SELECT id, to_timestamp(at / 1000.0), uid, sid, cause, op, node_id, node_type, path, from_path, attrs, props
        FROM jsonb_to_recordset($1::jsonb) AS r(
          id text, at double precision, uid integer, sid text, cause text, op text, node_id text,
          node_type text, path text, from_path text, attrs jsonb, props jsonb
        )
      `,
      values: [JSON.stringify(rows)],
    }, tx);
  }

  /** The statement `queryAudit` runs for `query`. */
  private auditQuerySql(query: AuditQuery): { text: string; values: unknown[] } {
    const where: string[] = [];
    const values: unknown[] = [];
    const param = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };

    if (query.id !== undefined) where.push(`id = ${param(query.id)}`);
    if (query.uid !== undefined) where.push(`uid = ${param(query.uid)}`);
    if (query.nodeId !== undefined) where.push(`node_id = ${param(query.nodeId)}`);
    if (query.cause !== undefined) where.push(`cause = ${param(query.cause)}`);
    if (query.op !== undefined) where.push(`op = ${param(query.op)}`);
    if (query.nodeTypes !== undefined) where.push(`node_type = ANY(${param(query.nodeTypes)}::text[])`);
    // A forward read is a range of the primary key, which the order below walks.
    if (query.after !== undefined) where.push(`id > ${param(query.after)}`);
    if (query.since !== undefined) where.push(`at >= to_timestamp(${param(query.since)} / 1000.0)`);
    if (query.until !== undefined) where.push(`at < to_timestamp(${param(query.until)} / 1000.0)`);
    if (query.pathPrefix !== undefined && query.pathPrefix !== '/') {
      const exact = param(query.pathPrefix);
      const below = param(query.pathPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '/%');
      where.push(`(path = ${exact} OR path LIKE ${below} OR from_path = ${exact} OR from_path LIKE ${below})`);
    }

    return {
      text: `
        SELECT id, (extract(epoch FROM at) * 1000)::bigint AS at, uid, sid, cause, op, node_id, node_type, path, from_path, attrs, props
        FROM ${this.auditTable}
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id ${query.after !== undefined ? 'ASC' : 'DESC'}
        LIMIT ${param(query.limit ?? 100)}
      `,
      values,
    };
  }

  async queryAudit(query: AuditQuery): Promise<AuditRecord[]> {
    const rows = await this.runParameterized(this.auditQuerySql(query));

    return rows.map((row) => ({
      id: row.id as string,
      timestamp: Number(row.at),
      uid: row.uid as UserId,
      ...(row.sid ? { sid: row.sid as string } : {}),
      ...(row.cause ? { cause: row.cause as string } : {}),
      op: row.op as AuditRecord['op'],
      nodeId: row.node_id as NodeId,
      nodeType: row.node_type as string,
      path: row.path as NodePath,
      ...(row.from_path ? { fromPath: row.from_path as NodePath } : {}),
      ...(row.attrs ? { attrs: row.attrs as AuditRecord['attrs'] } : {}),
      ...(row.props ? { props: row.props as AuditRecord['props'] } : {}),
    }));
  }

  // ===== Transaction Support =====

  /**
   * Begin a new transaction.
   * Acquires a dedicated connection and starts a transaction block.
   */
  async beginTransaction(): Promise<Transaction> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      return new PgTransaction(client);
    } catch (error) {
      client.release();
      throw error;
    }
  }
}
