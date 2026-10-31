/**
 * LocalNodeVFS: a `NodeVFS` over one `NodeStore`, adding what the store does not know — mounts,
 * path resolution, access checks, locking, events and the audit trail.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, isAbsolute, join, normalize, relative } from '@std/path';
import { ulid } from '@std/ulid';
import { Access, AccessLevel } from '../lib/access/types.ts';
import { ADMIN_ACCESS, modeUnder } from '../lib/access/constants.ts';
import { isTrashPath } from '../lib/paths.ts';
import type { RelationAttrs } from '../lib/api/relation.ts';
import { isAdmin, verifyAccess } from '../lib/access/verify-access.ts';
import { IdLockManager } from '../lib/async/mod.ts';
import { globToRegex } from '../lib/glob/mod.ts';
import { getMimeFromBuffer, isUntypedMimetype } from '../lib/media/mime.ts';
import { GroupId, Ownership, UserId } from '../lib/mode/mod.ts';
import { createLogger } from '../managers/logger/mod.ts';
import { RouterManagerIf } from '../managers/router/mod.ts';
import { SimilarityMatch, SimilarPair } from '../registries/embedding/mod.ts';
import { GeoBounds, NearbyMatch, PositionPoint, WithinMatch } from '../registries/position/mod.ts';
import type { TrackSummary } from '../registries/track/types.ts';
import {
  PoolClaimRequest,
  PoolCounts,
  PoolFailOptions,
  PoolJob,
  PoolJobFilter,
  PoolJobId,
  PoolJobInput,
  PoolJobSelector,
  PoolPurgeOptions,
  PoolRegistryIf,
  PoolSweepResult,
} from '../registries/pool/mod.ts';
import type { QueueDeadAction, QueueDeadEntry, QueueEntryId, QueuePeekEntry, QueueRegistryIf } from '../registries/queue/types.ts';
import { ResourceHandleIf, ResourceMode, ResourceStat } from '../registries/types.ts';
import { VfsEventEmitter } from '../vfs/event-emitter.ts';
import { SizeTrackingHandle } from '../vfs/size-tracking-handle.ts';
import { ContentWriteHandle } from './content-write-handle.ts';
import { type AuditInput, type AuditQuery, type AuditRecord, auditRecord, isPathWithin } from './audit.ts';
import { NODE_TYPE_POSITION } from './types/position.ts';
import { assertAccess, assertIdentityCreatable, assertIdentityUnchanged, assertOwnerAttrsUnchanged, assertOwnershipAllowed } from './assert-access.ts';
import { EPHEMERAL_NODE_TYPES } from './types/ephemeral.ts';
import { NODE_TYPE_FILE } from './types/file.ts';
import { NODE_TYPE_POOL } from './types/pool.ts';
import { NODE_TYPE_QUEUE } from './types/queue.ts';
import {
  NodeAccessDeniedError,
  NodeAlreadyExistsError,
  NodeBusyError,
  NodeFrozenError,
  NodeInvalidOperationError,
  NodeNotFoundError,
  NodeNotSupportedError,
  NodeReadonlyError,
  NodeTierImmutableError,
} from './errors.ts';
import type { EdgeMove, NodeStore, NodeUpdate, OwnerRelease, PathNode, ReleasedOwner, StoredPath, StoreNodeQuery, Transaction } from './node-store.ts';
import type { NodeVFS } from './node-vfs.ts';
import type { Node, NodeAttrs, NodeChild, NodeId, NodePath, NodeType } from './node.ts';
import {
  type AggregateBucket,
  compareAggregateKeys,
  compareText,
  type LinkEntry,
  type NodeAggregateQuery,
  type NodeQuery,
  type NodeQueryEntry,
  type ParentLink,
  type ResolvedPath,
  validateAggregateExtras,
} from './query.ts';
import {
  ChildCountOptions,
  ChildrenOptions,
  CopyOptions,
  EventSubscription,
  EventSubscriptionFilter,
  EventSubscriptionHandler,
  Mount,
  NodeAttrsUpdate,
  NodeChange,
  NodeChildEntry,
  NodeEntry,
  NodeEvent,
  NodeEventType,
  NodePropsCreate,
  NodePropsUpdate,
  NodeReference,
  NodeResolveOptions,
  NodeTreeSpec,
  RenamedNode,
  RenameManyOptions,
  RenameMove,
  UnlinkTarget,
  UpdateManyOptions,
  VfsRegistries,
  vfsRoutingKey,
} from './types.ts';
import type { IndexDecl } from '../lib/contributions/types.ts';

/** Admin passes every check `verifyAccess` makes, so reachability need not be computed for it. */
const bypassesAccess = isAdmin;

/** Whom a store counts an aggregate for: nobody in particular for an administrator. */
const readerOf = (access: Access): { reader?: Access } => bypassesAccess(access) ? {} : { reader: access };

/** Cycle guard for walking up the hierarchy. */
const MAX_PATH_DEPTH = 64;

const logger = createLogger('vfs');

/**
 * Deliveries held back while a copy writes its tree, one per mutation, in order; `copy` runs them
 * once the tree is whole. Shared by every LocalNodeVFS, so a copy into a mounted VFS holds that
 * VFS's events as well.
 */
const heldDeliveries = new AsyncLocalStorage<(() => Promise<void>)[]>();

const MAX_SOFTLINK_DEPTH = 40;

/** A softlink met during a path walk: its target, the directory it sits in and the path past it. */
type SoftlinkStep = { target: string; dir: NodePath; rest: string[]; depth: number };

/**
 * Thrown by a mounted VFS that meets a softlink: its target names a path in the global namespace,
 * which only the outermost VFS knows. Each VFS it passes on the way up rebases `dir` on its mount
 * point, so the one that is not mounted resolves the target as the caller's root sees it.
 */
class SoftlinkRedirect extends Error {
  constructor(public step: SoftlinkStep) {
    super(`softlink to ${step.target} left unresolved inside a mount`);
    this.name = 'SoftlinkRedirect';
  }
}

/**
 * Nodes written per transaction by the batched writes, `updateMany` and a recursive unlink. Large
 * enough that a big subtree is not thousands of round trips, small enough that the locks and row
 * locks a batch holds are never interesting to anyone else.
 */
const WRITE_BATCH = 128;

/** Passes in a row a recursive unlink makes while the tree moves under all it reads. */
const STALLED_PASSES = 5;

/** Times a recursive unlink empties a node again when children arrive before its last edge goes. */
const REFILLED_PASSES = 5;

/** Directories `childrenMany` lists per store read: a bound on the rows one read returns. */
const LIST_BATCH = 256;

/**
 * Storage deletes a batched unlink has in flight at once. Each is a few filesystem calls that wait
 * on the disk or a pooled connection, so one at a time a batch of files costs a round trip per file;
 * the bound leaves the pool to everyone else.
 */
const STORAGE_DELETES = 8;

/**
 * How far `query`'s request to a store grows while access keeps refusing what it reads. The
 * request is never below twice the rows still wanted, so a large `limit` asks for more at once.
 */
const QUERY_BATCH_MAX = 1000;

/**
 * Softlinks one chunk of `renameMany` re-points at most, all in its one transaction. More means a
 * move of a tree half the archive points into, which is refused rather than held in one write.
 */
const RELINK_LIMIT = 100_000;

// Node types whose byte content is streamed on copy
const CONTENT_COPY_TYPES = new Set<NodeType>(['file', 'embedding']);

/** A `renameMany` move with both parents resolved; `from` and `to` are in the caller's paths, which are what a softlink names. */
type PlannedMove = {
  index: number;
  fromParent: NodeEntry;
  fromName: string;
  toParent: NodeEntry;
  toName: string;
  from: NodePath;
  to: NodePath;
};

/** A planned move as its chunk read it before locking: the node at the source, and the one its destination name holds. */
type ReadMove = PlannedMove & { childId: NodeId; takenId?: NodeId };

/** A move its chunk's checks passed, with the nodes they read under the locks. */
type AcceptedMove<T extends NodeAttrs> = ReadMove & { node: Node<T>; oldParent: Node; newParent: Node; replaces?: NodeId };

/**
 * A chunk of moves read before its transaction: the moves still to make, the nodes they touch —
 * parents, the moved nodes and those their destination names hold — and the links to re-point.
 * The two sets of ids are its lock set.
 */
type MovePlan = { moves: ReadMove[]; nodeIds: NodeId[]; linkIds: Set<NodeId> };

/** An `unlinkMany` edge with its parent resolved; `path` is in the caller's paths. */
type PlannedUnlink = { index: number; parent: NodeEntry; name: string; path: NodePath };

/** A link a chunk re-points: the link as read, the move it follows, and its change. */
type Relink = { link: Node; move: PlannedMove; change: NodeUpdate };

/** The links to a chunk's moves changed between reading them and taking the locks: the lock set is stale. */
class LinksChangedError extends NodeInvalidOperationError {
  constructor() {
    super('the links to the moved paths changed during the move');
  }
}

/**
 * A node would lose its last link while it still has children. Under a recursive unlink they
 * arrived after its subtree was emptied, as a pipeline attaches a profile when membership changes.
 */
class NodeNotEmptyError extends NodeInvalidOperationError {
  constructor(path: NodePath) {
    super(`cannot unlink '${path}': node has children (use recursive)`);
  }
}

/** The key of the edge `name` under `parentId`. */
const edgeKey = (parentId: NodeId, name: string): string => `${parentId}\0${name}`;

/**
 * Where a path at or under one of `moves`' sources is once they are made: the longest source it
 * lies under wins, so a move nested in another moved tree is followed. Undefined for a path no
 * move covers, a relative one among them. A source named by several moves is the first one's.
 */
const movedPath = <M extends { from: NodePath; to: NodePath }>(moves: M[]): (path: NodePath) => { path: NodePath; move: M } | undefined => {
  const bySource = new Map<NodePath, M>();
  for (const move of moves) {
    if (!bySource.has(move.from)) bySource.set(move.from, move);
  }
  return (path) => {
    if (!path.startsWith('/')) return undefined;
    for (let at = path; at.length > 1; at = at.slice(0, at.lastIndexOf('/'))) {
      const move = bySource.get(at);
      if (move) return { path: move.to + path.slice(at.length), move };
    }
    return undefined;
  };
};

/** A node a copy will write, with its children, read before the copy writes anything. */
type CopyPlan = { node: Node; sourcePath: NodePath; name: string; children: CopyPlan[] };

/** A node a copy has created: its source, the copy as last written, and its path in the destination VFS. */
type CopyWritten = { source: Node; copy: Node; path: NodePath };

/**
 * A mutation in flight: the transaction it runs in, and the way it announces
 * what it did.
 *
 * Every store read and write inside a mutation goes through `tx`, and every
 * event it produces goes through `emit`. `emit` is deliberately synchronous and
 * returns nothing — it queues the event, and `withTransaction` delivers the
 * queue after the commit. There is no way to reach a subscriber from inside a
 * mutation, which is the point: see `deliverEvents`.
 *
 * `audit` is its counterpart for the audit trail, and the opposite in timing:
 * `withTransaction` writes the queued records inside the transaction, just
 * before the commit, so a change and its record commit or vanish together.
 */
type Mutation = {
  tx: Transaction;
  audit(access: Access, input: AuditInput): void;
  emit<T extends NodeAttrs = NodeAttrs>(
    type: NodeEventType,
    path: NodePath,
    node: Node<T>,
    previousNode?: Node<T>,
    uid?: UserId,
    fromPath?: NodePath,
  ): void;
  /**
   * Run `work` once the transaction has committed, still under the operation's
   * locks. For registry storage, whose calls take their own pool connection:
   * made inside the transaction, each writer would hold one connection while
   * waiting for a second (ein/core#350).
   */
  afterCommit(work: () => Promise<void>): void;
};

/**
 * Attr names whose value differs between two snapshots of one node. Structural
 * values are compared serialised — attrs are JSON, so that is their identity.
 */
const changedAttrNames = (before: NodeAttrs, after: NodeAttrs): string[] => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];

  for (const name of names) {
    const a = before[name];
    const b = after[name];
    const same = a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
    if (!same) changed.push(name);
  }

  return changed;
};

type LocalNodeVfsOptions = {
  /**
   * Subtrees, in this VFS's own paths, whose writes leave no audit record: machine state such as
   * `/var`, where a crawl's pipeline bookkeeping would otherwise be most of the trail. A move is
   * recorded unless both its ends lie inside.
   */
  unaudited?: readonly NodePath[];
};

export class LocalNodeVFS implements NodeVFS {
  private mountpoints: Mount[] = [];
  private eventEmitter = new VfsEventEmitter((access, path) => this.pathReachable(access, path));
  private mountSubscriptions: Map<NodeVFS, EventSubscription> = new Map();
  private lockManager = new IdLockManager();
  /** Mounted into another VFS, which publishes this one's events under their absolute paths. */
  private mounted = false;

  constructor(
    private store: NodeStore,
    private routerManager: RouterManagerIf,
    /** Owned by this VFS: `initialize` starts them and `dispose` stops them. */
    private regs: VfsRegistries,
    private options: LocalNodeVfsOptions = {},
  ) {}

  // ===== Locking and Transaction Helpers =====

  /**
   * Execute an operation with per-node locking and transaction support.
   *
   * The full lock set is taken up front in sorted order and the transaction is
   * opened only once every lock is held — never the other way round, or a
   * caller would sit on a pool connection while waiting for a mutex. Both are
   * released when the operation returns, so no caller ever holds a lock or a
   * transaction while starting another one.
   *
   * Events the operation produces are buffered on the `Mutation` and delivered
   * here — after the commit, after every lock is gone, and only if the
   * operation succeeded. Work queued with `afterCommit` runs between the two:
   * after the commit, before the locks go.
   */
  private async withTransaction<T>(
    nodeIds: string[],
    operation: (mut: Mutation) => Promise<T>,
  ): Promise<T> {
    const events: NodeEvent[] = [];
    /** The containers this write has announced a change of membership for, by event type and path. */
    const containers = new Set<string>();

    const emit: Mutation['emit'] = (type, path, node, previousNode, uid, fromPath) => {
      // A container's membership changing is one fact, however many children the write moved.
      if (type === 'child-attached' || type === 'child-detached') {
        const key = `${type} ${path}`;
        if (containers.has(key)) return;
        containers.add(key);
      }
      events.push({
        id: ulid(),
        type,
        path,
        node,
        previousNode,
        ...(fromPath !== undefined ? { fromPath } : {}),
        timestamp: Date.now(),
        uid: uid ?? 0,
      });
    };

    // Whether a write leaves a trail is the store's call: pg always keeps one,
    // the memory store only when asked (tests), the rest never. Paths are this
    // VFS's own — relative to its mount point; `audit` rebases them on read.
    const records: AuditRecord[] = [];
    const audit: Mutation['audit'] = (access, input) => {
      if (!this.store.auditing || EPHEMERAL_NODE_TYPES.has(input.node.type) || this.unaudited(input)) return;
      const record = auditRecord(access, input);
      if (record) records.push(record);
    };

    const committed: (() => Promise<void>)[] = [];
    const afterCommit: Mutation['afterCommit'] = (work) => {
      committed.push(work);
    };

    const result = await this.lockManager.withLocks(nodeIds, async () => {
      const tx = await this.store.beginTransaction();
      let result: T;
      try {
        result = await operation({ tx, emit, audit, afterCommit });
        if (records.length > 0) await this.store.appendAudit!(records, tx);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }

      for (const work of committed) await work();

      return result;
    });

    // An event names the record its node's write left, so whatever the event sets off can point
    // back at that write. The parent an event like `child-attached` names left no record of its own.
    if (records.length > 0) {
      const recordIds = new Map(records.map((r) => [r.nodeId, r.id]));
      for (const event of events) {
        const auditId = recordIds.get(event.node.id);
        if (auditId) event.auditId = auditId;
      }
    }

    await this.deliverEvents(events);

    return result;
  }

  /** Whether a write lies wholly inside the subtrees `options.unaudited` names. */
  private unaudited({ path, fromPath }: AuditInput): boolean {
    const prefixes = this.options.unaudited ?? [];
    const inside = (p: NodePath) => prefixes.some((prefix) => isPathWithin(p, prefix));
    return inside(path) && (fromPath === undefined || inside(fromPath));
  }

  /** Declare one node's write to its transaction; see `Transaction.declareWrite`. */
  private declareWrite(mut: Mutation, type: NodeType): void {
    mut.tx.declareWrite?.(EPHEMERAL_NODE_TYPES.has(type) ? 'ephemeral' : 'durable');
  }

  // ===== Event Emission =====

  /** Put one event on the queues. Nothing here may throw — see `deliverEvents`. */
  private async publish(event: NodeEvent): Promise<void> {
    if (event.unpublished) return;

    // Published on `system.vfs.<nodeType>.<eventType>`, granular enough that a
    // consumer binds only the handful it can act on and never pays to store,
    // read, parse and ack the rest — a tty update per line a command prints
    // would otherwise reach every queue. Bindings may be patterns
    // (`system.vfs.file.*`), but `system.vfs.#` puts a consumer back on all of it.
    //
    // In-process subscribers (`subscribe`) get every event regardless, filtered
    // by their EventSubscriptionFilter.
    try {
      await this.routerManager.publish(
        vfsRoutingKey(event.node.type, event.type),
        {
          id: event.id,
          type: event.type,
          path: event.path,
          nodeId: event.node.id,
          nodeType: event.node.type,
          timestamp: event.timestamp,
          uid: event.uid,
          ...(event.auditId ? { auditId: event.auditId } : {}),
          // What a consumer cannot recover by reading the node fresh.
          // Which attrs an `updated` event changed, by name.
          ...(event.previousNode ? { changedAttrs: changedAttrNames(event.previousNode.attrs, event.node.attrs) } : {}),
          // What a deleted node was: by the time a consumer reads, it is gone.
          ...(event.type === 'deleted' ? { attrs: event.node.attrs } : {}),
          // Where a moved node came from, which its new path no longer says.
          ...(event.fromPath !== undefined ? { fromPath: event.fromPath } : {}),
        },
      );
    } catch (error) {
      logger.error('event publish failed', { error, type: event.type, path: event.path });
    }
  }

  /**
   * Deliver a mutation's events, once it owns nothing anyone else can want.
   *
   * Handlers are awaited, so a caller sees its own event delivered before its
   * write returns — but they run outside the transaction and outside the lock
   * set, which is what makes it safe for one to touch the VFS. A handler run
   * inside would deadlock on any lock the write still holds, and neither
   * postgres (it sees a transaction waiting on a JS promise) nor the mutex (it
   * sees no transaction) could break that cycle.
   *
   * Nothing here may throw: the mutation is already committed, so a failure to
   * announce it cannot be reported as a failure to perform it.
   */
  private async deliverEvents(events: NodeEvent[]): Promise<void> {
    const held = heldDeliveries.getStore();
    if (held) {
      held.push(() => this.deliverEvents(events));
      return;
    }

    for (const event of events) {
      // A mounted VFS knows its paths only relative to its mount point: a write
      // under /tmp would reach every queue consumer as /x instead of /tmp/x, and
      // resolve to nothing. The outermost VFS publishes it instead, from the
      // mount subscription, with the path rewritten (see `mount`).
      if (!this.mounted) await this.publish(event);

      try {
        await this.eventEmitter.emit(event);
      } catch (error) {
        logger.error('event delivery failed', { error, type: event.type, path: event.path });
      }
    }
  }

  // ===== Identity (delegated to backend) =====

  get name(): string {
    return this.store.name;
  }

  get type() {
    return this.store.type;
  }

  get source(): string | undefined {
    return this.store.source;
  }

  get rootId(): NodeId {
    return this.store.rootId;
  }

  get supportsMount(): boolean {
    return this.store.supportsMount;
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    await this.store.initialize();

    for (const reg of Object.values(this.regs)) {
      await reg.init();
    }
  }

  async dispose(): Promise<void> {
    for (const [_vfs, sub] of this.mountSubscriptions) {
      await sub.unsubscribe();
    }
    this.mountSubscriptions.clear();

    this.eventEmitter.clear();

    // Mounts first, then this VFS's own registries and store.
    for (const mount of this.mountpoints) {
      await mount.vfs.dispose();
    }
    this.mountpoints = [];

    for (const reg of Object.values(this.regs)) {
      await reg.dispose();
    }

    await this.store.dispose();
  }

  async isHealthy(): Promise<boolean> {
    return await this.store.isHealthy();
  }

  // ===== Mount Management =====

  /**
   * Throw if the resolved entry lives inside a read-only mount of this vfs.
   * No-op for local targets (entry.vfs === this) and for targets under
   * writable mounts. Nested mounts are guarded per-level: each LocalNodeVFS
   * checks its own mount points using its own absPath namespace.
   */
  private assertMountWritable(entry: NodeEntry): void {
    if (entry.vfs === this) return;
    for (const m of this.mountpoints) {
      if (!m.options?.readonly) continue;
      const base = m.point.absPath;
      const covered = base === '/' ||
        entry.absPath === base ||
        entry.absPath.startsWith(base + '/');
      if (covered) throw new NodeReadonlyError(entry.absPath);
    }
  }

  async mount(
    access: Access,
    path: NodePath,
    vfs: NodeVFS,
    opts?: Mount['options'] & {
      opts?: NodeResolveOptions;
    },
  ): Promise<void> {
    if (!this.supportsMount) {
      throw new Error(`Mount is not supported by ${this.name}`);
    }

    const normalizedPath = this.normalizePath(path);
    const entry = await this.resolvePath(access, normalizedPath, opts?.opts);

    if (!entry) {
      throw new NodeNotFoundError(normalizedPath);
    }

    this.assertMountWritable(entry);

    if (entry.vfs === this) {
      // Check write access to the mount point
      const node = await this.store.getNode(entry.id);

      assertAccess(access, node, 'w');
      await vfs.initialize();

      if (!await vfs.isHealthy()) {
        throw new Error(`Backend ${vfs.name} is not healthy`);
      }

      const mountPoint: Mount = {
        point: entry,
        vfs,
        mounted: {
          uid: access.uid,
          timestamp: Date.now(),
        },
        options: {
          readonly: opts?.readonly,
          publish: opts?.publish,
        },
      };

      this.mountpoints.push(mountPoint);

      // Subscribe to the mounted VFS for event propagation. The mounted VFS
      // stops publishing its own events, so this is where they reach the
      // queues — with the path it could not know. Nested mounts forward inward
      // to outward until the outermost VFS, the only one not mounted, publishes.
      //
      // Subscribed as admin, not as whoever mounted it: this relay is not a
      // reader. Each subscriber on this side is still filtered by its own access
      // when the event is re-emitted, and the queues never were.
      vfs.setMounted?.(true);
      if (vfs.subscribe) {
        const mountPath = entry.absPath || normalizedPath;
        const subscription = await vfs.subscribe(() => ADMIN_ACCESS, async (event) => {
          const rewrittenEvent: NodeEvent = {
            ...event,
            path: join(mountPath, event.path),
            ...(event.fromPath !== undefined ? { fromPath: join(mountPath, event.fromPath) } : {}),
            // Stays marked through any outer relays, up to the one that publishes
            ...(opts?.publish === false ? { unpublished: true as const } : {}),
          };
          if (!this.mounted) await this.publish(rewrittenEvent);
          try {
            await this.eventEmitter.emit(rewrittenEvent);
          } catch (error) {
            logger.error('event delivery failed', { error, type: rewrittenEvent.type, path: rewrittenEvent.path });
          }
        });
        this.mountSubscriptions.set(vfs, subscription);
      }

      return;
    }

    return await entry.vfs.mount(access, entry.vfsAbsPath, vfs, opts);
  }

  async unmount(
    access: Access,
    path: NodePath,
    opts?: NodeResolveOptions,
  ): Promise<void> {
    if (!this.supportsMount) {
      throw new Error(`Unmount is not supported by ${this.name}`);
    }

    const normalizedPath = this.normalizePath(path);

    // The mount table first, by the path `mounts` lists: a mount point that a later mount covers
    // (one at `/` covers them all) no longer resolves to this VFS's node.
    const listed = this.mountpoints.find((m) => m.point.vfsAbsPath === normalizedPath);
    if (listed) {
      return await this.detachMount(access, listed);
    }

    const entry = await this.resolvePath(access, normalizedPath, { ...opts, readmount: true });

    this.assertMountWritable(entry);

    if (entry.vfs === this) {
      const mount = this.mountpoints.find((m) => m.point.id === entry.id);

      if (!mount) {
        throw new Error(`No mount at path: ${normalizedPath}`);
      }

      return await this.detachMount(access, mount);
    }

    return await entry.vfs.unmount(access, entry.vfsAbsPath, opts);
  }

  /** Remove one of this VFS's mounts, which needs write access to the node it is mounted on. */
  private async detachMount(access: Access, mount: Mount): Promise<void> {
    const node = await this.store.getNode(mount.point.id);
    assertAccess(access, node, 'w');

    // Unsubscribe from mounted VFS events
    const mountSub = this.mountSubscriptions.get(mount.vfs);
    if (mountSub) {
      await mountSub.unsubscribe();
      this.mountSubscriptions.delete(mount.vfs);
    }
    mount.vfs.setMounted?.(false);

    await mount.vfs.dispose();
    this.mountpoints = this.mountpoints.filter((m) => m != mount);
  }

  mounts(access: Access): Mount[] {
    if (!this.supportsMount) {
      return [];
    }

    const allMounts: Mount[] = [];

    for (const mount of this.mountpoints) {
      allMounts.push(mount);

      const nestedMounts = mount.vfs.mounts(access);

      for (const nestedMount of nestedMounts) {
        const mountPath = mount.point.absPath || '/';
        const nestedPath = nestedMount.point.absPath || '/';

        allMounts.push({
          ...nestedMount,
          point: {
            ...nestedMount.point,
            absPath: join(mountPath, nestedPath),
          },
        });
      }
    }

    return allMounts;
  }

  // ===== Work Pools =====

  /**
   * Resolve a `pool` node to the id its registry knows it by, checking access
   * at `level` on the way. Routing mirrors {@link open}: the caller has already
   * delegated to a foreign mount, so the node is ours by the time we get here.
   */
  private async poolTarget(access: Access, entry: NodeEntry, level: AccessLevel): Promise<{ id: string; reg: PoolRegistryIf }> {
    if (level === 'w') {
      this.assertMountWritable(entry);
    }

    const node = await this.store.getNode(entry.id);
    assertAccess(access, node, level);

    if (node.type !== NODE_TYPE_POOL || !this.regs.pool) {
      throw new NodeNotSupportedError(node.type);
    }

    return { id: entry.id, reg: this.regs.pool };
  }

  async poolAdd(access: Access, ref: NodeReference, job: PoolJobInput): Promise<PoolJob> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolAdd(access, entry, job);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.add(id, job);
  }

  async poolClaim(access: Access, ref: NodeReference, req: PoolClaimRequest, signal?: AbortSignal): Promise<PoolJob | null> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolClaim(access, entry, req, signal);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.claim(id, req, signal);
  }

  async poolHeartbeat(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolHeartbeat(access, entry, jobId, owner, leaseMs);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.heartbeat(id, jobId, owner, leaseMs);
  }

  async poolComplete(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolComplete(access, entry, jobId, owner, result);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.complete(id, jobId, owner, result);
  }

  async poolFail(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, error: string, opts?: PoolFailOptions): Promise<PoolJob | null> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolFail(access, entry, jobId, owner, error, opts);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.fail(id, jobId, owner, error, opts);
  }

  async poolRelease(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, delayMs?: number): Promise<PoolJob | null> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolRelease(access, entry, jobId, owner, delayMs);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.release(id, jobId, owner, delayMs);
  }

  async poolCancel(access: Access, ref: NodeReference, sel: PoolJobSelector): Promise<number> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolCancel(access, entry, sel);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.cancel(id, sel);
  }

  async poolRetry(access: Access, ref: NodeReference, sel: PoolJobSelector): Promise<number> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolRetry(access, entry, sel);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.retry(id, sel);
  }

  async poolPurge(access: Access, ref: NodeReference, opts?: PoolPurgeOptions): Promise<number> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolPurge(access, entry, opts);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.purge(id, opts);
  }

  async poolJobs(access: Access, ref: NodeReference, filter?: PoolJobFilter): Promise<PoolJob[]> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolJobs(access, entry, filter);

    const { id, reg } = await this.poolTarget(access, entry, 'r');
    return await reg.jobs(id, filter);
  }

  async poolCounts(access: Access, ref: NodeReference): Promise<PoolCounts> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolCounts(access, entry);

    const { id, reg } = await this.poolTarget(access, entry, 'r');
    return await reg.counts(id);
  }

  async poolSweep(access: Access, ref: NodeReference): Promise<PoolSweepResult> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.poolSweep(access, entry);

    const { id, reg } = await this.poolTarget(access, entry, 'w');
    return await reg.sweep(id);
  }

  // ===== Queue Operations =====

  async queuePeek(access: Access, ref: NodeReference, limit: number): Promise<QueuePeekEntry[]> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.queuePeek(access, entry, limit);

    const { id, reg } = await this.queueTarget(access, entry, 'r');
    return await reg.peek(id, limit);
  }

  async queueDead(access: Access, ref: NodeReference, limit: number): Promise<QueueDeadEntry[]> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.queueDead(access, entry, limit);

    const { id, reg } = await this.queueTarget(access, entry, 'r');
    return await reg.deadLetters(id, limit);
  }

  async queueSettleDead(access: Access, ref: NodeReference, action: QueueDeadAction, ids?: QueueEntryId[]): Promise<number> {
    const entry = await this.resolveEntry(access, ref);
    if (entry.vfs !== this) return await entry.vfs.queueSettleDead(access, entry, action, ids);

    const { id, reg } = await this.queueTarget(access, entry, 'w');
    return await reg.settleDead(id, action, ids);
  }

  /** The queue registry and its key for a queue node of this VFS, after checking `level` on it. */
  private async queueTarget(access: Access, entry: NodeEntry, level: AccessLevel): Promise<{ id: string; reg: QueueRegistryIf }> {
    if (level === 'w') {
      this.assertMountWritable(entry);
    }

    const node = await this.store.getNode(entry.id);
    assertAccess(access, node, level);

    if (node.type !== NODE_TYPE_QUEUE || !this.regs.queue) {
      throw new NodeNotSupportedError(node.type);
    }

    // The registry key `open` uses: a filesystem store names resources by path.
    return { id: this.store.pathAddressed ? entry.vfsAbsPath : entry.id, reg: this.regs.queue };
  }

  // ===== Reachability =====
  //
  // A path walk asserts execute on every directory it passes (`resolvePathInternal`). A node
  // found any other way — by id, from an attr query, from a registry — must meet the same rule,
  // or a directory's mode gates nothing: `/home/<user>/staging` is 0700 while the files in it
  // keep 0775, and an index lookup would hand them to anyone. These helpers apply the rule to a
  // batch at once. A node is reachable when at least one of its paths has execute on every
  // ancestor, the root included; a mount point's ancestors are checked in the VFS it sits in
  // (`mountReachable`) and the mounted tree's in its own. A store that keeps reach on its nodes
  // (`NodeStore.reachable`) answers for a whole batch at once; for any other the parents are
  // walked. A path handed back is judged on its own (`pathsIn`): of a node linked twice, one path
  // may be open and the other not.

  /** Access columns for many ids in this store; ids it does not hold are absent. */
  private async ownershipOf(ids: NodeId[]): Promise<Map<NodeId, Ownership>> {
    if (this.store.getOwnership) return await this.store.getOwnership(ids);

    const result = new Map<NodeId, Ownership>();
    if (this.store.getNodes) {
      for (const [id, node] of await this.store.getNodes(ids)) result.set(id, node.props);
      return result;
    }
    for (const id of new Set(ids)) {
      // A filesystem or command store is handed ids it cannot decode; that is "not here".
      const node = await this.store.getNode(id).catch(() => undefined);
      if (node) result.set(id, node.props);
    }
    return result;
  }

  /** Which parent each id hangs under, from whichever batch read the store offers. */
  private async parentLinksOf(ids: NodeId[]): Promise<Map<NodeId, ParentLink[]>> {
    if (this.store.getParentLinksMany) return await this.store.getParentLinksMany(ids);

    const result = new Map<NodeId, ParentLink[]>();
    for (const id of new Set(ids)) {
      const links = this.store.getParentLinks
        ? await this.store.getParentLinks(id).catch(() => [])
        : (await this.store.getParents(id).catch(() => [])).map((parent) => ({ parentId: parent.id, name: '' }));
      if (links.length > 0) result.set(id, links);
    }
    return result;
  }

  /** The paths in this store `access` may follow to each id; see `pathsIn`. */
  private async traversablePaths(access: Access, ids: NodeId[]): Promise<Map<NodeId, ResolvedPath[]>> {
    return (await this.pathsIn(access, ids)).open;
  }

  /**
   * The paths in this store `access` may follow to each id — execute on every ancestor — and
   * which of the ids this store placed at all.
   *
   * `open` lacks an id with no such path; `held` still has it, so a caller fanning out across
   * mounts knows not to look for it elsewhere. Admin keeps every path but those in a trash
   * (`isTrashPath`): a trashed node is held and has no path, for everyone, until it is restored.
   *
   * `reached` says the store's reach admits `access` to every id. A node with a single path is
   * then open along it, since that path is the only one its reach was made from; only the
   * ancestors of nodes linked more than once are read.
   */
  private async pathsIn(access: Access, ids: NodeId[], reached = false): Promise<{ open: Map<NodeId, ResolvedPath[]>; held: Set<NodeId> }> {
    const result = new Map<NodeId, ResolvedPath[]>();
    const held = new Set<NodeId>();
    if (ids.length === 0) return { open: result, held };

    if (!this.store.resolvePaths) {
      for (const id of new Set(ids)) {
        let entries: NodeEntry[];
        try {
          entries = await this.walkId(access, id);
        } catch {
          continue;
        }
        held.add(id);
        // The walk has no parent id to offer; use the node's own, as `resolveIdEntries` always has.
        const paths = entries.filter((entry) => !isTrashPath(entry.vfsAbsPath)).map((entry) => ({ path: entry.vfsAbsPath, parentId: entry.id }));
        if (paths.length > 0) result.set(id, paths);
      }
      return { open: result, held };
    }

    const resolved = await this.store.resolvePaths(ids);
    const strip = ({ path, parentId }: StoredPath): ResolvedPath => ({ path, parentId });
    for (const [id, paths] of resolved) {
      held.add(id);
      const live = paths.filter((path) => !isTrashPath(path.path));
      // Counted with the trash: reach may admit a node through a trashed path alone.
      if (reached && paths.length === 1) {
        if (live.length === 1) result.set(id, live.map(strip));
        resolved.delete(id);
      } else if (live.length < paths.length) resolved.set(id, live);
    }

    if (bypassesAccess(access)) {
      for (const [id, paths] of resolved) if (paths.length > 0) result.set(id, paths.map(strip));
      return { open: result, held };
    }

    const ancestors = new Set<NodeId>();
    for (const paths of resolved.values()) {
      for (const path of paths) for (const ancestor of path.ancestors) ancestors.add(ancestor);
    }
    const owners = await this.ownershipOf([...ancestors]);
    const passable = (id: NodeId) => {
      const owner = owners.get(id);
      return owner !== undefined && verifyAccess(access, owner, 'x');
    };

    for (const [id, paths] of resolved) {
      const open = paths.filter((path) => path.ancestors.every(passable)).map(strip);
      if (open.length > 0) result.set(id, open);
    }
    return { open: result, held };
  }

  /**
   * The ids in this store that `access` can reach and that grant it `level` themselves.
   *
   * Reachable means the store's reach admits the caller, or for a store keeping none, some parent
   * is a directory the caller can pass through (`traversableDirs`); the root is reachable by
   * definition.
   */
  private async reachableIds(access: Access, ids: NodeId[], level?: AccessLevel): Promise<Set<NodeId>> {
    const unique = [...new Set(ids)];
    if (this.store.reachable && !bypassesAccess(access)) {
      const reached = await this.store.reachable(access, unique);
      return new Set([...reached].filter(([, owner]) => level === undefined || verifyAccess(access, owner, level)).map(([id]) => id));
    }
    let held = unique;
    if (level !== undefined || !bypassesAccess(access)) {
      const owners = await this.ownershipOf(unique);
      held = unique.filter((id) => {
        const owner = owners.get(id);
        return owner !== undefined && (level === undefined || verifyAccess(access, owner, level));
      });
    }
    if (bypassesAccess(access)) return new Set(held);

    const links = await this.parentLinksOf(held.filter((id) => id !== this.rootId));
    const parents = new Set<NodeId>();
    for (const list of links.values()) for (const link of list) parents.add(link.parentId);
    const open = await this.traversableDirs(access, [...parents]);

    return new Set(held.filter((id) => id === this.rootId || (links.get(id) ?? []).some((link) => open.has(link.parentId))));
  }

  /**
   * Directories in this store `access` can reach and pass through: execute of their own, and a
   * parent that is such a directory in turn, up to the root.
   *
   * Walked upward a level at a time — one parent-link read and one access-column read per level —
   * rather than resolving every id's full path: the ids here are often thousands of files (the
   * parents of their `position` or `faces` children), but a level up they are a few hundred
   * folders, and a level above that a handful. Each level asks only about ids not already seen,
   * so shared ancestors are read once.
   */
  private async traversableDirs(access: Access, ids: NodeId[]): Promise<Set<NodeId>> {
    if (ids.length === 0) return new Set();

    const owners = new Map<NodeId, Ownership>();
    const parents = new Map<NodeId, NodeId[]>();
    let frontier = [...new Set(ids)];
    for (let depth = 0; frontier.length > 0 && depth <= MAX_PATH_DEPTH; depth++) {
      const [levelOwners, levelLinks] = await Promise.all([
        this.ownershipOf(frontier),
        this.parentLinksOf(frontier.filter((id) => id !== this.rootId)),
      ]);
      const next = new Set<NodeId>();
      for (const id of frontier) {
        const owner = levelOwners.get(id);
        if (!owner) continue;
        owners.set(id, owner);
        // Only a directory the caller can pass through is worth climbing above.
        if (!verifyAccess(access, owner, 'x')) continue;
        const up = [...new Set((levelLinks.get(id) ?? []).map((link) => link.parentId))];
        parents.set(id, up);
        for (const parent of up) if (!owners.has(parent)) next.add(parent);
      }
      frontier = [...next];
    }

    // Top-down over what was read: open when passable and the root, or with an open parent.
    const open = new Map<NodeId, boolean>();
    const isOpen = (id: NodeId): boolean => {
      const known = open.get(id);
      if (known !== undefined) return known;
      open.set(id, false); // a cycle, which the VFS forbids, reads as closed
      const owner = owners.get(id);
      const result = owner !== undefined && verifyAccess(access, owner, 'x') &&
        (id === this.rootId || (parents.get(id) ?? []).some(isOpen));
      open.set(id, result);
      return result;
    };

    return new Set(ids.filter(isOpen));
  }

  /**
   * Whether `access` can reach what is mounted at `mount`: execute on every ancestor of the mount
   * point here. The point itself is not checked — the mounted root stands in for it, and the
   * mounted VFS checks that as the first ancestor of everything under it.
   */
  private async mountReachable(access: Access, mount: Mount): Promise<boolean> {
    if (bypassesAccess(access) || mount.point.id === this.rootId) return true;
    return (await this.traversablePaths(access, [mount.point.id])).has(mount.point.id);
  }

  /**
   * Of `ids`, found in this VFS or any mount, those `access` can reach and read.
   *
   * For results a registry hands back by id: the registry knows nothing about the tree, so its
   * hits are filtered here before anything is told they exist.
   */
  private async visibleIds(access: Access, ids: NodeId[]): Promise<Set<NodeId>> {
    if (ids.length === 0 || bypassesAccess(access)) return new Set(ids);

    const visible = await this.reachableIds(access, ids, 'r');
    const owners = await this.ownershipOf(ids);
    let pending = ids.filter((id) => !owners.has(id));

    for (const mount of this.mountpoints) {
      if (pending.length === 0) break;
      if (!(mount.vfs instanceof LocalNodeVFS) || !(await this.mountReachable(access, mount))) continue;
      for (const id of await mount.vfs.visibleIds(access, pending)) visible.add(id);
      const held = await mount.vfs.ownershipOf(pending);
      pending = pending.filter((id) => !held.has(id));
    }

    return visible;
  }

  /**
   * Whether `access` can walk to the directory holding `path` and pass through it — what an event
   * subscriber must be able to do for the event's node to be visible to it.
   *
   * Resolving the path itself asserts execute on every directory above the last segment, which is
   * exactly the rule; the node may already be gone (a `deleted` event), and a missing last segment
   * is not a refusal.
   */
  private async pathReachable(access: Access, path: NodePath): Promise<boolean> {
    if (bypassesAccess(access) || path === '/') return true;
    try {
      await this.resolvePath(access, path, { readlink: true });
      return true;
    } catch (error) {
      if (error instanceof NodeAccessDeniedError) return false;
      if (!(error instanceof NodeNotFoundError)) throw error;
    }
    // Gone: the directory it was in must still be one the subscriber can pass through.
    try {
      const entry = await this.resolvePath(access, dirname(path));
      return verifyAccess(access, (await entry.vfs.get(ADMIN_ACCESS, entry)).props, 'x');
    } catch {
      return false;
    }
  }

  /** What `mount` answered, or nothing when the caller cannot reach its mount point; asked only when there is something to hide. */
  private async throughMount<T>(access: Access, mount: Mount, found: T[]): Promise<T[]> {
    return found.length === 0 || await this.mountReachable(access, mount) ? found : [];
  }

  /** The registry hits whose every node id `access` can reach and read in this store. */
  private async onlyVisible<T>(access: Access, hits: T[], idsOf: (hit: T) => string[]): Promise<T[]> {
    if (hits.length === 0 || bypassesAccess(access)) return hits;
    const visible = await this.reachableIds(access, hits.flatMap(idsOf), 'r');
    return hits.filter((hit) => idsOf(hit).every((id) => visible.has(id)));
  }

  // ===== Similarity Search =====

  async findSimilar(
    access: Access,
    embeddingType: string,
    data: Uint8Array,
    limit = 10,
    threshold?: number,
    within?: NodeId[],
  ): Promise<SimilarityMatch[]> {
    const matches: SimilarityMatch[] = [];

    if (this.regs.embedding) {
      // Over-fetch: the registry cannot see access, and filtering drops rows.
      const own = await this.regs.embedding.findSimilar(embeddingType, data, bypassesAccess(access) ? limit : limit * 2, threshold, within);
      matches.push(...await this.onlyVisible(access, own, (match) => [match.id]));
    }

    for (const mount of this.mountpoints) {
      matches.push(...await this.throughMount(access, mount, await mount.vfs.findSimilar(access, embeddingType, data, limit, threshold, within)));
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, limit);
  }

  async findAllPairs(
    access: Access,
    embeddingType: string,
    limit = 10,
    threshold?: number,
  ): Promise<SimilarPair[]> {
    const pairs: SimilarPair[] = [];

    // A mount that has never stored this embedding type has no vectors table;
    // that specific error is expected and skipped. Anything else propagates.
    const collect = async (get: () => Promise<SimilarPair[]>): Promise<void> => {
      try {
        // Push element-by-element: an all-pairs result can be very large and
        // `push(...spread)` would overflow the call stack (unlike findSimilar,
        // which returns only `limit` matches).
        const result = await get();
        for (const p of result) pairs.push(p);
      } catch (error) {
        if (!/relation .* does not exist|undefined[_ ]table/i.test(String(error))) throw error;
      }
    };

    if (this.regs.embedding) {
      await collect(async () => await this.onlyVisible(access, await this.regs.embedding!.findAllPairs(embeddingType, limit, threshold), (pair) => [pair.a, pair.b]));
    }
    for (const mount of this.mountpoints) {
      await collect(async () => await this.throughMount(access, mount, await mount.vfs.findAllPairs(access, embeddingType, limit, threshold)));
    }

    return pairs;
  }

  async getVectors(
    access: Access,
    embeddingType: string,
    ids: NodeId[],
  ): Promise<Map<NodeId, Uint8Array>> {
    const vectors = new Map<NodeId, Uint8Array>();
    if (ids.length === 0) return vectors;

    // Same tolerance as findAllPairs: a mount that never stored this embedding
    // type has no vectors table, and that specific error means "none here".
    const collect = async (get: () => Promise<Map<string, Uint8Array>>): Promise<void> => {
      try {
        for (const [id, data] of await get()) vectors.set(id, data);
      } catch (error) {
        if (!/relation .* does not exist|undefined[_ ]table/i.test(String(error))) throw error;
      }
    };

    if (this.regs.embedding) {
      await collect(async () => {
        const own = await this.regs.embedding!.getVectors(embeddingType, ids);
        const visible = await this.reachableIds(access, [...own.keys()], 'r');
        return new Map([...own].filter(([id]) => visible.has(id)));
      });
    }
    for (const mount of this.mountpoints) {
      await collect(async () => {
        const found = await mount.vfs.getVectors(access, embeddingType, ids);
        return found.size === 0 || await this.mountReachable(access, mount) ? found : new Map();
      });
    }

    return vectors;
  }

  // ===== Geo Search =====

  async findNearby(
    access: Access,
    lat: number,
    lng: number,
    radiusMeters = 10000,
    limit = 10,
  ): Promise<NearbyMatch[]> {
    const matches: NearbyMatch[] = [];

    if (this.regs.position) {
      const own = await this.regs.position.findNearby(lat, lng, radiusMeters, bypassesAccess(access) ? limit : limit * 2);
      matches.push(...await this.onlyVisible(access, own, (match) => [match.id]));
    }

    for (const mount of this.mountpoints) {
      matches.push(...await this.throughMount(access, mount, await mount.vfs.findNearby(access, lat, lng, radiusMeters, limit)));
    }

    matches.sort((a, b) => a.distance - b.distance);
    return matches.slice(0, limit);
  }

  async findWithin(
    access: Access,
    bounds: GeoBounds,
    limit = 100,
  ): Promise<WithinMatch[]> {
    const matches: WithinMatch[] = [];

    if (this.regs.position) {
      matches.push(...await this.onlyVisible(access, await this.regs.position.findWithin(bounds, limit), (match) => [match.id]));
    }

    for (const mount of this.mountpoints) {
      matches.push(...await this.throughMount(access, mount, await mount.vfs.findWithin(access, bounds, limit)));
    }

    return matches.slice(0, limit);
  }

  async findContaining(
    access: Access,
    lat: number,
    lng: number,
    limit = 10,
  ): Promise<NearbyMatch[]> {
    const matches: NearbyMatch[] = [];

    if (this.regs.position) {
      const own = await this.regs.position.findContaining(lat, lng, bypassesAccess(access) ? limit : limit * 2);
      matches.push(...await this.onlyVisible(access, own, (match) => [match.id]));
    }

    for (const mount of this.mountpoints) {
      matches.push(...await this.throughMount(access, mount, await mount.vfs.findContaining(access, lat, lng, limit)));
    }

    matches.sort((a, b) => a.distance - b.distance);
    return matches.slice(0, limit);
  }

  async getPoints(access: Access, ids: NodeId[]): Promise<Map<NodeId, PositionPoint>> {
    const points = new Map<NodeId, PositionPoint>();
    if (ids.length === 0) return points;

    if (this.regs.position) {
      const own = await this.regs.position.getPoints(ids);
      const visible = await this.onlyVisible(access, [...own.keys()], (id) => [id]);
      for (const id of visible) points.set(id, own.get(id)!);
    }
    for (const mount of this.mountpoints) {
      const found = await mount.vfs.getPoints(access, ids);
      if (found.size > 0 && await this.mountReachable(access, mount)) { for (const [id, point] of found) points.set(id, point); }
    }

    return points;
  }

  async trackSummaries(access: Access, ids: NodeId[]): Promise<Map<NodeId, TrackSummary>> {
    const summaries = new Map<NodeId, TrackSummary>();
    if (ids.length === 0) return summaries;

    if (this.regs.track) {
      const own = await this.regs.track.summaries(ids);
      const visible = await this.onlyVisible(access, [...own.keys()], (id) => [id]);
      for (const id of visible) summaries.set(id, own.get(id)!);
    }
    for (const mount of this.mountpoints) {
      const found = await mount.vfs.trackSummaries(access, ids);
      if (found.size > 0 && await this.mountReachable(access, mount)) { for (const [id, summary] of found) summaries.set(id, summary); }
    }

    return summaries;
  }

  // ===== Attribute Queries =====

  /**
   * Fewer than `limit` entries means nothing is left: each store is read until it has given
   * `limit` readable, reachable rows or has none left, and the stores' answers are merged in
   * order. `within` is answered by the store holding its root alone; `notWithin` reaches every
   * store holding one of its roots.
   */
  async query(access: Access, query: NodeQuery): Promise<NodeQueryEntry[]> {
    const excluded = await this.excludedRoots(query.notWithin);
    if (query.within === undefined) return await this.queryEverywhere(access, query, excluded);
    return await this.queryWithin(access, await this.scopeRoot(access, query.within), query, excluded);
  }

  /**
   * The root a `within` names, resolved with the caller's access, which needs read and execute on
   * it as listing it does.
   */
  private async scopeRoot(access: Access, path: NodePath): Promise<NodeEntry> {
    const root = await this.resolvePath(access, path);
    const node = await root.vfs.get(ADMIN_ACCESS, root);
    assertAccess(access, node, 'r');
    assertAccess(access, node, 'x');
    return root;
  }

  /**
   * `notWithin`'s roots, resolved with administrative access and grouped by the VFS holding each.
   * A root that does not resolve is left out.
   */
  private async excludedRoots(paths: NodePath[] | undefined): Promise<Map<NodeVFS, NodeId[]>> {
    const roots = new Map<NodeVFS, NodeId[]>();
    for (const path of paths ?? []) {
      const entry = await this.resolvePath(ADMIN_ACCESS, path).catch((error) => {
        if (error instanceof NodeNotFoundError) return undefined;
        throw error;
      });
      if (entry) roots.set(entry.vfs, [...roots.get(entry.vfs) ?? [], entry.id]);
    }
    return roots;
  }

  /** The mount that `vfs` is, or lies within, among this VFS's mounts. */
  private mountHolding(vfs: NodeVFS): Mount | undefined {
    return this.mountpoints.find((mount) => mount.vfs === vfs || (mount.vfs instanceof LocalNodeVFS && mount.vfs.mountHolding(vfs) !== undefined));
  }

  /** `query` within `root`, asked of the store that holds it; paths come back in this VFS's terms. */
  private async queryWithin(access: Access, root: NodeEntry, query: NodeQuery, excluded: Map<NodeVFS, NodeId[]>): Promise<NodeQueryEntry[]> {
    const { within: _within, notWithin: _notWithin, ...rest } = query;
    if (root.vfs === this) return await this.queryStore(access, { ...rest, withinId: root.id, notWithinIds: excluded.get(this) });

    const mount = this.mountHolding(root.vfs);
    if (!(mount?.vfs instanceof LocalNodeVFS)) return [];
    const found = await mount.vfs.queryWithin(access, root, query, excluded);
    return found.map((entry) => ({ ...entry, absPath: join(mount.point.vfsAbsPath, entry.absPath) }));
  }

  /** `query` of this VFS's store and every mount, merged in order. */
  private async queryEverywhere(access: Access, query: NodeQuery, excluded: Map<NodeVFS, NodeId[]>): Promise<NodeQueryEntry[]> {
    const { within: _within, notWithin: _notWithin, ...rest } = query;
    const entries = await this.queryStore(access, { ...rest, notWithinIds: excluded.get(this) });

    for (const mount of this.mountpoints) {
      const answered = mount.vfs instanceof LocalNodeVFS ? await mount.vfs.queryEverywhere(access, query, excluded) : await mount.vfs.query(access, rest);
      const mounted = await this.throughMount(access, mount, answered);
      for (const entry of mounted) {
        entries.push({ ...entry, absPath: join(mount.point.vfsAbsPath, entry.absPath) });
      }
    }

    const dir = query.orderBy?.dir ?? 'asc';
    const sign = dir === 'desc' ? -1 : 1;
    entries.sort((a, b) => {
      if (a.sortValue !== b.sortValue) {
        return compareText(a.sortValue ?? '', b.sortValue ?? '', query.orderBy?.collation) * sign;
      }
      if (a.id === b.id) return a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0;
      return (a.id < b.id ? -1 : 1) * sign;
    });

    return entries.slice(0, query.limit);
  }

  /**
   * This store's rows, in its order, until `limit` entries are in hand or the store has none left.
   * A row the caller cannot read, or reach by a path it could walk, is dropped, and the store is
   * asked again from after it. A store keeping reach drops those rows itself (`reader`), so it is
   * asked for what is still wanted; any other is asked for twice that, more while a run of refused
   * rows goes on, so a feed never ends early behind rows its reader cannot see.
   */
  private async queryStore(access: Access, query: StoreNodeQuery): Promise<NodeQueryEntry[]> {
    const entries: NodeQueryEntry[] = [];
    if (!this.store.queryNodes || query.limit <= 0) return entries;

    const filtered = !bypassesAccess(access);
    const reached = filtered && this.store.reachable !== undefined;
    let after = query.after;
    let asked = 0;
    for (;;) {
      const remaining = query.limit - entries.length;
      asked = filtered && !reached ? Math.max(2 * remaining, Math.min(2 * asked, QUERY_BATCH_MAX)) : remaining;
      const rows = await this.store.queryNodes({ ...query, after, limit: asked, ...(reached ? { reader: access } : {}) });
      const readable = rows.filter((row) => verifyAccess(access, row.node.props, 'r'));

      // One batched resolution for the whole batch rather than a walk per row.
      const { open } = await this.pathsIn(access, readable.map((row) => row.node.id), reached);
      for (const row of readable) {
        // No reachable path (in a trash, behind a directory the caller cannot pass) drops the row.
        for (const resolved of open.get(row.node.id) ?? []) {
          entries.push({ id: row.node.id, absPath: resolved.path, node: row.node, sortValue: row.sortValue });
        }
      }

      if (entries.length >= query.limit || rows.length < asked) return entries;
      const last = rows[rows.length - 1];
      after = { value: last.sortValue, id: last.node.id };
    }
  }

  /** How many nodes are within `path`, up to `cap`; see `NodeStore.countWithin`. */
  async countWithin(access: Access, path: NodePath, cap: number): Promise<number> {
    return await this.countIn(await this.scopeRoot(access, path), cap);
  }

  private async countIn(root: NodeEntry, cap: number): Promise<number> {
    if (root.vfs === this) return await this.store.countWithin?.(root.id, cap) ?? 0;
    const mount = this.mountHolding(root.vfs);
    return mount?.vfs instanceof LocalNodeVFS ? await mount.vfs.countIn(root, cap) : 0;
  }

  async findLinks(access: Access, targets: NodePath | NodePath[], limit = 10000): Promise<LinkEntry[]> {
    return await this.findLinksIn(access, Array.isArray(targets) ? targets : [targets], limit, false);
  }

  async findLinksUnder(access: Access, paths: NodePath[], limit = 10000): Promise<LinkEntry[]> {
    return await this.findLinksIn(access, paths, limit, true);
  }

  /** `findLinks`, or with `under` `findLinksUnder`: this store's links and every mount's. */
  private async findLinksIn(access: Access, wanted: NodePath[], limit: number, under: boolean): Promise<LinkEntry[]> {
    const entries: LinkEntry[] = [];
    if (wanted.length === 0 || limit <= 0) return entries;

    const find = under ? this.store.findSoftlinksUnder?.bind(this.store) : this.store.findSoftlinks?.bind(this.store);
    if (find) {
      // Over-fetch: access filtering and unresolvable ids both
      // drop rows, and the store cannot account for either.
      const links = await find(wanted, limit * 2);
      const readable = links.filter((link) => verifyAccess(access, link.props, 'r'));

      const resolved = await this.resolveIdEntries(access, readable.map((link) => link.id));

      for (const link of readable) {
        for (const entry of resolved.get(link.id) ?? []) {
          entries.push({
            id: link.id,
            absPath: entry.path,
            parentId: entry.parentId,
            target: link.props.softlink!,
            node: link,
          });
        }
      }
    }

    // Targets are passed down unchanged: a softlink stores whatever path was
    // given to it, and mounted stores hold links written in their own terms.
    for (const mount of this.mountpoints) {
      const found = under ? await mount.vfs.findLinksUnder(access, wanted, limit) : await mount.vfs.findLinks(access, wanted, limit);
      const mounted = await this.throughMount(access, mount, found);
      for (const entry of mounted) {
        entries.push({ ...entry, absPath: join(mount.point.vfsAbsPath, entry.absPath) });
      }
    }

    return entries.slice(0, limit);
  }

  async ensureAttrIndexes(access: Access, indexes: IndexDecl[]): Promise<void> {
    if (!isAdmin(access)) throw new NodeAccessDeniedError(this.store.rootId, 'ensureAttrIndexes');
    await this.store.ensureAttrIndexes?.(indexes);
    // The pg store is normally mounted at `/` under a router-only root, whose own store has no
    // indexes to make, so every mount is asked too.
    for (const mount of this.mountpoints) await mount.vfs.ensureAttrIndexes(access, indexes);
  }

  async releaseOwner(access: Access, release: OwnerRelease): Promise<ReleasedOwner> {
    if (!isAdmin(access)) throw new NodeAccessDeniedError(this.store.rootId, 'releaseOwner');
    const released = await this.store.releaseOwner?.(release, access.uid) ?? { owned: 0, acl: 0 };
    for (const mount of this.mountpoints) {
      const mounted = await mount.vfs.releaseOwner(access, release);
      released.owned += mounted.owned;
      released.acl += mounted.acl;
    }
    return released;
  }

  async reachNamed(access: Access): Promise<{ uids: UserId[]; gids: GroupId[] }> {
    if (!isAdmin(access)) throw new NodeAccessDeniedError(this.store.rootId, 'reachNamed');
    const uids = new Set<UserId>();
    const gids = new Set<GroupId>();
    for (const named of [await this.store.reachNamed?.(), ...await Promise.all(this.mountpoints.map((mount) => mount.vfs.reachNamed(access)))]) {
      for (const uid of named?.uids ?? []) uids.add(uid);
      for (const gid of named?.gids ?? []) gids.add(gid);
    }
    return { uids: [...uids].sort((a, b) => a - b), gids: [...gids].sort((a, b) => a - b) };
  }

  async audit(access: Access, query: AuditQuery): Promise<AuditRecord[]> {
    if (!isAdmin(access)) throw new NodeAccessDeniedError(this.store.rootId, 'audit');

    const limit = query.limit ?? 100;
    const records = this.store.auditing ? await this.store.queryAudit!({ ...query, limit }) : [];

    // The pg store is normally mounted at `/` under a router-only root, so the
    // trail lives one level down. A mount's records carry paths
    // relative to its mount point; the prefix goes in the same way.
    for (const mount of this.mountpoints) {
      const point = mount.point.vfsAbsPath;
      let pathPrefix: NodePath | undefined;
      if (query.pathPrefix !== undefined) {
        if (isPathWithin(point, query.pathPrefix)) {
          pathPrefix = undefined;
        } else if (isPathWithin(query.pathPrefix, point)) {
          pathPrefix = join('/', query.pathPrefix.slice(point.length));
        } else {
          continue;
        }
      }

      const rebase = (path: NodePath) => join(point, path);
      for (const r of await mount.vfs.audit(access, { ...query, pathPrefix, limit })) {
        records.push({ ...r, path: rebase(r.path), ...(r.fromPath ? { fromPath: rebase(r.fromPath) } : {}) });
      }
    }

    const order = query.after !== undefined ? -1 : 1;
    return records.sort((a, b) => (a.id < b.id ? order : a.id > b.id ? -order : 0)).slice(0, limit);
  }

  /**
   * `within` is counted by the store holding its root alone. Otherwise every store is asked and
   * the buckets merged, `counts` by name. `minCount` is then a property of the merged bucket, so
   * the store under this VFS's root — the one holding the tree, which the mounts only add to — is
   * asked for the buckets that could still reach it after the others' counts are added, and the
   * mounts for every bucket.
   */
  async aggregate(access: Access, query: NodeAggregateQuery): Promise<AggregateBucket[]> {
    validateAggregateExtras(query);
    const excluded = await this.excludedRoots(query.notWithin);
    if (query.within !== undefined) return await this.aggregateWithin(access, await this.scopeRoot(access, query.within), query, excluded);
    return await this.aggregateEverywhere(access, query, excluded);
  }

  private async aggregateWithin(access: Access, root: NodeEntry, query: NodeAggregateQuery, excluded: Map<NodeVFS, NodeId[]>): Promise<AggregateBucket[]> {
    const { within: _within, notWithin: _notWithin, ...rest } = query;
    if (root.vfs === this) return await this.store.groupCount?.({ ...rest, withinId: root.id, notWithinIds: excluded.get(this), ...readerOf(access) }) ?? [];
    const mount = this.mountHolding(root.vfs);
    return mount?.vfs instanceof LocalNodeVFS ? await mount.vfs.aggregateWithin(access, root, query, excluded) : [];
  }

  private async aggregateEverywhere(access: Access, query: NodeAggregateQuery, excluded: Map<NodeVFS, NodeId[]>): Promise<AggregateBucket[]> {
    const { within: _within, notWithin: _notWithin, minCount, ...rest } = query;
    const merged = new Map<string, AggregateBucket>();
    const add = (buckets: AggregateBucket[]) => {
      for (const bucket of buckets) {
        const id = JSON.stringify(bucket.key);
        const running = merged.get(id);
        if (!running) {
          merged.set(id, { ...bucket, ...(bucket.counts ? { counts: { ...bucket.counts } } : {}) });
          continue;
        }
        running.count += bucket.count;
        if (bucket.sum !== undefined) running.sum = (running.sum ?? 0) + bucket.sum;
        for (const [name, count] of Object.entries(bucket.counts ?? {})) {
          running.counts = { ...running.counts, [name]: (running.counts?.[name] ?? 0) + count };
        }
      }
    };
    const fromMount = async (mount: Mount, floor?: number) => {
      if (!(await this.mountReachable(access, mount))) return [];
      const asked = { ...rest, ...(floor !== undefined ? { minCount: floor } : {}) };
      return mount.vfs instanceof LocalNodeVFS ? await mount.vfs.aggregateEverywhere(access, asked, excluded) : await mount.vfs.aggregate(access, asked);
    };

    const rootMount = this.mountpoints.find((mount) => mount.point.id === this.rootId);
    const others = this.mountpoints.filter((mount) => mount !== rootMount);
    if (rootMount && this.store.groupCount) add(await this.store.groupCount({ ...rest, notWithinIds: excluded.get(this), ...readerOf(access) }));
    for (const mount of others) add(await fromMount(mount));

    // A bucket reaches `minCount` only if the root's store holds at least `minCount` less the most
    // any bucket gathered elsewhere.
    const gathered = Math.max(0, ...[...merged.values()].map((bucket) => bucket.count));
    const floor = minCount === undefined ? undefined : Math.max(1, minCount - gathered);
    if (rootMount) add(await fromMount(rootMount, floor));
    else if (this.store.groupCount) {
      add(await this.store.groupCount({ ...rest, ...(floor !== undefined ? { minCount: floor } : {}), notWithinIds: excluded.get(this), ...readerOf(access) }));
    }

    // `sum` stays absent unless it was asked for — a store that does not
    // implement it must not look like one that summed to zero.
    return [...merged.values()]
      .filter((bucket) => bucket.count >= (minCount ?? 1))
      .map((bucket) => ({ ...bucket, ...(query.sum !== undefined ? { sum: bucket.sum ?? 0 } : {}) }))
      .sort((a, b) => compareAggregateKeys(a.key, b.key));
  }

  // ===== Path Utilities =====

  protected normalizePath(path: NodePath): NodePath {
    const normalized = normalize(path);
    return normalized === '.' ? '/' : normalized;
  }

  async resolvePath(
    access: Access,
    path: NodePath,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry> {
    return this.resolvePathInternal(access, path, 0, opts);
  }

  private async resolvePathInternal(
    access: Access,
    path: NodePath,
    depth: number,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry> {
    if (depth > MAX_SOFTLINK_DEPTH) {
      throw new Error('too many levels of symbolic links');
    }
    const forcereadmount = path.startsWith('!');
    const follow = opts?.follow !== false; // default true
    const readlink = opts?.readlink ?? false; // default false
    const readmount = (opts?.readmount || forcereadmount) ?? false; // default false

    const strippedPath = path.startsWith('!') ? path.slice(1) : path;
    const normalizedPath = this.normalizePath(strippedPath);

    if (normalizedPath === '/') {
      if (!readmount) {
        const mount = this.mountpoints.find((m) => m.point.id === this.rootId);

        if (mount) {
          return await this.resolveInMount(access, '/', () => mount.vfs.resolvePath(access, '/', opts), opts);
        }
      }

      return {
        id: this.rootId,
        vfs: this,
        vfsAbsPath: '/',
        absPath: '/',
      };
    }

    const rootEntry = await this.resolvePath(access, '/', { ...opts, readmount: forcereadmount });

    if (rootEntry.vfs === this) {
      const segments = normalizedPath.split('/').filter(Boolean);
      let accumulatedPath = '';

      // The whole path in one recursive descent where the store can do it. This
      // only fetches the nodes — every per-level check below still runs in
      // order, so a mount point or a softlink diverts at its own level and the
      // levels past it are never used. The chain stops wherever the hierarchy
      // does, and the loop falls back to a single lookup for anything it did
      // not cover.
      const resolved = await this.store.resolveChain?.(this.rootId, segments);
      let node: PathNode = resolved?.root ?? await this.store.getNode(this.rootId);
      const chain = resolved?.entries ?? [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        accumulatedPath += '/' + segment;

        // Traversal requires execute permission on every path component
        assertAccess(access, node, 'x');

        // One indexed lookup per level: name is unique within a parent, and the
        // child node comes back with it, so a level costs a single query.
        const child: PathNode | undefined = chain[i] ?? (await this.store.getChildren(node.id, { name: segment }))[0]?.node;

        if (!child) {
          throw new NodeNotFoundError(normalizedPath);
        }

        // `readmount` keeps only the last segment's mount; a forced one (`!`) keeps them all
        if (!readmount || (!forcereadmount && i < segments.length - 1)) {
          const mount = this.mountpoints.find((m) => m.point.id === child.id);

          if (mount) {
            const restPath = '/' + segments.slice(i + 1).join('/');
            return await this.resolveInMount(access, accumulatedPath, async () => {
              try {
                return { ...await mount.vfs.resolvePath(access, restPath, opts), absPath: normalizedPath };
              } catch (error) {
                // The mount only knows the path from its own root; say the one the caller asked for.
                if (error instanceof NodeNotFoundError) throw new NodeNotFoundError(normalizedPath);
                throw error;
              }
            }, opts);
          }
        }

        node = child;

        // Handle softlinks
        if (node.props.softlink && follow) {
          const isLastSegment = i === segments.length - 1;

          // If readlink=true and this is the last segment, don't follow
          if (isLastSegment && readlink) {
            continue; // Return the link node itself
          }

          return this.followSoftlink(access, {
            target: node.props.softlink,
            dir: dirname(accumulatedPath),
            rest: segments.slice(i + 1),
            depth,
          }, opts);
        }
      }

      return {
        id: node.id,
        vfs: this,
        vfsAbsPath: normalizedPath,
        absPath: normalizedPath,
      };
    }

    return await this.resolveInMount(access, '/', () => rootEntry.vfs.resolveEntry(access, path, opts), opts);
  }

  /** Resolve through the VFS mounted at `mountPath`, following here a softlink it hands up. */
  private async resolveInMount(
    access: Access,
    mountPath: NodePath,
    resolve: () => Promise<NodeEntry>,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry> {
    try {
      return await resolve();
    } catch (error) {
      if (!(error instanceof SoftlinkRedirect)) throw error;
      return await this.followSoftlink(access, { ...error.step, dir: join(mountPath, error.step.dir) }, opts);
    }
  }

  /**
   * Resolve the path a softlink leads to: its target, relative to the directory holding the link
   * unless absolute, followed by the rest of the walk. A mounted VFS hands it to the VFS above.
   */
  private followSoftlink(access: Access, step: SoftlinkStep, opts?: NodeResolveOptions): Promise<NodeEntry> {
    if (this.mounted) throw new SoftlinkRedirect(step);
    const target = isAbsolute(step.target) ? step.target : join(step.dir, step.target);
    return this.resolvePathInternal(access, join(target, ...step.rest), step.depth + 1, opts);
  }

  // ===== Public Node Operations =====

  async get<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<Node<T>> {
    const entry = await this.resolveEntry(access, ref, opts);

    if (entry.vfs === this) {
      const node = await this.store.getNode<T>(entry.id);
      assertAccess(access, node, 'r');
      return node;
    }

    return await entry.vfs.get<T>(access, entry, opts);
  }

  async children<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    parentRef: NodeReference,
    opts?: NodeResolveOptions & ChildrenOptions,
  ): Promise<NodeChildEntry<T>[]> {
    const entry = await this.resolveEntry(access, parentRef, opts);

    if (entry.vfs === this) {
      if (opts?.page && opts.filter?.name) {
        throw new NodeInvalidOperationError('a page of children cannot be filtered by name');
      }

      // Check read and execute access to the parent directory
      const parent = await this.store.getNode(entry.id);
      assertAccess(access, parent, 'r');
      assertAccess(access, parent, 'x');

      let result = await this.readableChildren<T>(access, entry.id, opts);

      // Apply name filter if specified
      if (opts?.filter?.name) {
        const regex = typeof opts.filter.name === 'string' ? globToRegex(opts.filter.name) : opts.filter.name;
        result = result.filter((c) => regex.test(c.name));
      }

      [result] = await this.withReadableCounts(access, [result], opts);
      result = await this.withMountedRoots(access, result, opts);

      if (opts?.childLinks) {
        const links = await this.readableLinks(access, await this.childLinksFor(result.map((child) => child.node.id)));
        result = result.map((child) => ({ ...child, children: links.get(child.node.id) ?? [] }));
      }

      return result;
    }

    return await entry.vfs.children<T>(access, entry, opts);
  }

  /**
   * The children of a directory the caller may read, or one page of them, each page one store
   * query (no getNode per child). A child the caller may not read is left out, as `query` leaves
   * it out: a private album in a shared folder is not listed at all, rather than listed with its
   * name and attrs and nothing inside. A page is read on past hidden children until it holds
   * `limit` or the store has no more, so fewer than `limit` still means the listing has ended.
   */
  private async readableChildren<T extends NodeAttrs>(
    access: Access,
    id: NodeId,
    opts?: Pick<ChildrenOptions, 'page' | 'types'>,
  ): Promise<NodeChildEntry<T>[]> {
    const readable = (child: NodeChildEntry<T>) => verifyAccess(access, child.node.props, 'r');
    const types = opts?.types ? { types: opts.types } : {};
    const page = opts?.page;
    if (!page) return (await this.store.getChildren<T>(id, types)).filter(readable);

    const result: NodeChildEntry<T>[] = [];
    let after = page.after;
    while (result.length < page.limit) {
      const read = await this.store.getChildren<T>(id, { page: { limit: page.limit, ...(after !== undefined ? { after } : {}) }, ...types });
      result.push(...read.filter(readable));
      if (read.length < page.limit) break;
      after = read[read.length - 1].name;
    }
    return result.slice(0, page.limit);
  }

  async childrenMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    refs: NodeReference[],
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<PromiseSettledResult<NodeChildEntry<T>[]>[]> {
    return await this.byOwner(access, refs, opts, undefined, (vfs, entries) => {
      return vfs === this ? this.listBatches<T>(access, entries, opts) : vfs.childrenMany<T>(access, entries, opts);
    });
  }

  /** `childrenMany` over entries of this VFS's own, `LIST_BATCH` directories per read. */
  private async listBatches<T extends NodeAttrs>(
    access: Access,
    entries: NodeEntry[],
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<PromiseSettledResult<NodeChildEntry<T>[]>[]> {
    const results: PromiseSettledResult<NodeChildEntry<T>[]>[] = [];

    for (let start = 0; start < entries.length; start += LIST_BATCH) {
      const batch = entries.slice(start, start + LIST_BATCH);
      const named = new Map(batch.map((entry) => [entry.id, entry.absPath || entry.vfsAbsPath]));
      const ids = [...named.keys()];

      // Each directory checked as `children` checks it.
      const directories = await this.readNodes(ids);
      const refused = new Map<NodeId, unknown>();
      for (const id of ids) {
        const directory = directories.get(id);
        try {
          if (!directory) {
            throw new NodeNotFoundError(named.get(id)!);
          }
          assertAccess(access, directory, 'r');
          assertAccess(access, directory, 'x');
        } catch (error) {
          refused.set(id, error);
        }
      }

      const listed = ids.filter((id) => !refused.has(id));
      const stored = await this.childrenOf<T>(listed, refused);
      // Without what the caller may not read, as `children` lists it.
      const readable = listed.map((id) => (stored.get(id) ?? []).filter((child) => verifyAccess(access, child.node.props, 'r')));
      const counted = await this.withReadableCounts(access, readable, opts);
      const listings = new Map(listed.map((id, i) => [id, counted[i]]));

      for (const entry of batch) {
        if (refused.has(entry.id)) {
          results.push({ status: 'rejected', reason: refused.get(entry.id) });
        } else {
          results.push({ status: 'fulfilled', value: await this.withMountedRoots(access, listings.get(entry.id) ?? [], opts) });
        }
      }
    }

    return results;
  }

  /**
   * The children of many directories, in one store read where the store can. A directory with none
   * is absent. Without the store's batched form each is listed alone, and one that fails is put in
   * `refused`.
   */
  private async childrenOf<T extends NodeAttrs>(ids: NodeId[], refused: Map<NodeId, unknown>): Promise<Map<NodeId, NodeChildEntry<T>[]>> {
    if (this.store.getChildrenMany) {
      return await this.store.getChildrenMany<T>(ids);
    }

    const listings = new Map<NodeId, NodeChildEntry<T>[]>();
    for (const id of ids) {
      try {
        listings.set(id, await this.store.getChildren<T>(id));
      } catch (error) {
        refused.set(id, error);
      }
    }
    return listings;
  }

  /**
   * Listings with each entry's `childCount` cut to the children the caller may read, all of them
   * at once, unless `opts.all` asks for every child.
   */
  private async withReadableCounts<T extends NodeAttrs>(
    access: Access,
    listings: NodeChildEntry<T>[][],
    opts?: ChildCountOptions,
  ): Promise<NodeChildEntry<T>[][]> {
    if (opts?.all || isAdmin(access)) return listings;

    const parents = listings.flat().filter((child) => child.childCount > 0).map((child) => child.node.id);
    if (parents.length === 0) return listings;

    const counts = await this.readableChildCounts(access, parents);
    return listings.map((listing) => listing.map((child) => child.childCount > 0 ? { ...child, childCount: counts.get(child.node.id) ?? 0 } : child));
  }

  /**
   * How many children of each of `parentIds` the caller may read; a parent with none is absent. In
   * one read where the store counts them itself, otherwise from the parents' edges and the
   * children's access columns.
   */
  private async readableChildCounts(access: Access, parentIds: NodeId[]): Promise<Map<NodeId, number>> {
    if (this.store.countReadableChildren) return await this.store.countReadableChildren(access, parentIds);

    const counts = new Map<NodeId, number>();
    for (const [id, links] of await this.readableLinks(access, await this.childLinksFor(parentIds))) {
      if (links.length > 0) counts.set(id, links.length);
    }
    return counts;
  }

  /** Child edges without those to children the caller may not read, judged by one read of their access columns. */
  private async readableLinks(access: Access, links: Map<NodeId, NodeChild[]>): Promise<Map<NodeId, NodeChild[]>> {
    if (isAdmin(access)) return links;

    const owners = await this.ownershipOf([...links.values()].flat().map((link) => link.id));
    const readable = (link: NodeChild) => {
      const owner = owners.get(link.id);
      return owner !== undefined && verifyAccess(access, owner, 'r');
    };
    return new Map([...links].map(([id, children]) => [id, children.filter(readable)]));
  }

  /** A listing with each child that has something mounted on it shown as the mounted root. */
  private async withMountedRoots<T extends NodeAttrs>(
    access: Access,
    listing: NodeChildEntry<T>[],
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<NodeChildEntry<T>[]> {
    return await Promise.all(listing.map(async (child) => {
      const mount = this.mountpoints.find((m) => m.point.id === child.node.id);
      if (!mount) return child;

      const node = await mount.vfs.get<T>(access, '/', opts);
      return { ...child, node, childCount: await mount.vfs.childCount(access, '/', opts) };
    }));
  }

  /** Child edges for many nodes, batched when the store can do it. */
  private async childLinksFor(ids: NodeId[]): Promise<Map<NodeId, NodeChild[]>> {
    if (this.store.getChildLinksMany) {
      return await this.store.getChildLinksMany(ids);
    }

    const links = new Map<NodeId, NodeChild[]>();
    for (const id of ids) {
      // Only a store without the batched form comes here — the filesystem and command
      // stores, whose ids are encoded paths. Handed another store's id, they fail to find it
      // or fail to decode it; either way that id has no children here, which is all the
      // answer says.
      const children = await this.store.getChildLinks(id).catch(() => [] as NodeChild[]);
      links.set(id, children);
    }
    return links;
  }

  async childCount(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<number> {
    const entry = await this.resolveEntry(access, ref, opts);

    if (entry.vfs === this) {
      const node = await this.store.getNode(entry.id);
      assertAccess(access, node, 'r');

      if (opts?.all || isAdmin(access)) return await this.store.countChildren(entry.id);
      return (await this.readableChildCounts(access, [entry.id])).get(entry.id) ?? 0;
    }

    return await entry.vfs.childCount(access, entry, opts);
  }

  /**
   * Fetch many nodes by id, access-filtered, across this VFS and its mounts.
   *
   * Rows carry no hierarchy (see NodeStore.getNodes). Nodes the caller cannot
   * read or reach (execute on every ancestor of some path to them), or that do
   * not exist, are simply absent from the map.
   */
  async getNodesByIds<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, Node<T>>> {
    const result = new Map<NodeId, Node<T>>();
    if (ids.length === 0) return result;

    const pending = new Set(ids);

    if (this.store.getNodes) {
      const readable: Node<T>[] = [];
      for (const [id, node] of await this.store.getNodes<T>([...pending])) {
        pending.delete(id);
        if (verifyAccess(access, node.props, 'r')) readable.push(node);
      }
      const reachable = await this.reachableIds(access, readable.map((node) => node.id));
      for (const node of readable) if (reachable.has(node.id)) result.set(node.id, node);
    }

    for (const mount of this.mountpoints) {
      if (pending.size === 0) break;
      const found = await mount.vfs.getNodesByIds<T>(access, [...pending]);
      const reachable = found.size === 0 || await this.mountReachable(access, mount);
      for (const [id, node] of found) {
        pending.delete(id);
        if (reachable) result.set(id, node);
      }
    }

    return result;
  }

  /** `resolveIdEntries` without the parent ids. */
  async resolveIdPaths(access: Access, ids: NodeId[]): Promise<Map<NodeId, string[]>> {
    const entries = await this.resolveIdEntries(access, ids);
    return new Map([...entries].map(([id, list]) => [id, list.map((entry) => entry.path)]));
  }

  async resolveIdEntries(access: Access, ids: NodeId[]): Promise<Map<NodeId, ResolvedPath[]>> {
    const result = new Map<NodeId, ResolvedPath[]>();
    if (ids.length === 0) return result;

    const pending = new Set(ids);

    // Only the paths the caller could have walked; an id held here with none of those is still
    // this store's, so it is not looked for in the mounts either.
    const { open, held } = await this.pathsIn(access, [...pending]);
    for (const [id, resolved] of open) result.set(id, resolved);
    for (const id of held) pending.delete(id);

    // Whatever the root store couldn't location may live in a mount.
    for (const mount of this.mountpoints) {
      if (pending.size === 0) break;
      const mounted = await mount.vfs.resolveIdEntries(access, [...pending]);
      const reachable = mounted.size === 0 || await this.mountReachable(access, mount);
      for (const [id, entries] of mounted) {
        if (reachable) result.set(id, entries.map((entry) => ({ ...entry, path: join(mount.point.vfsAbsPath, entry.path) })));
        pending.delete(id);
      }
    }

    return result;
  }

  async getParentLinksByIds(access: Access, ids: NodeId[]): Promise<Map<NodeId, ParentLink[]>> {
    const result = new Map<NodeId, ParentLink[]>();
    if (ids.length === 0) return result;

    const pending = new Set(ids);

    const found = new Map<NodeId, ParentLink[]>();
    if (this.store.getParentLinksMany) {
      for (const [id, links] of await this.store.getParentLinksMany([...pending])) {
        if (links.length > 0) found.set(id, links);
      }
    } else if (this.store.getParentLinks) {
      for (const id of [...pending]) {
        const links = await this.store.getParentLinks(id);
        if (links.length > 0) found.set(id, links);
      }
    }

    // A link is only as visible as its parent: one the caller could walk to and pass through.
    // An administrator passes through every parent the store links, so only others are checked.
    // The id is this store's either way, so it is not looked for in the mounts.
    const parents = new Set<NodeId>();
    for (const links of found.values()) for (const link of links) parents.add(link.parentId);
    const open = bypassesAccess(access) ? parents : await this.reachableIds(access, [...parents], 'x');
    for (const [id, links] of found) {
      pending.delete(id);
      const visible = links.filter((link) => open.has(link.parentId));
      if (visible.length > 0) result.set(id, visible);
    }

    // Whatever the root store doesn't hold may live in a mount. The parent id
    // is the mount's own, which is what the caller asked for — only paths need
    // the mount point prefixed, and this returns none.
    for (const mount of this.mountpoints) {
      if (pending.size === 0) break;
      const found = await mount.vfs.getParentLinksByIds(access, [...pending]);
      const reachable = found.size === 0 || await this.mountReachable(access, mount);
      for (const [id, links] of found) {
        if (reachable) result.set(id, links);
        pending.delete(id);
      }
    }

    return result;
  }

  async getChildLinksByIds(access: Access, ids: NodeId[]): Promise<Map<NodeId, NodeChild[]>> {
    const result = new Map<NodeId, NodeChild[]>();
    const pending = new Set(ids);
    // Two passes over the whole mount tree. First every store that can say which ids it holds
    // answers exactly those — a leaf with no children — so they go no further. Only then do the
    // stores that cannot (filesystem, command: their ids are encoded paths) try what is left,
    // one at a time. In one pass mount order would decide, and a filesystem mount ahead of the
    // data store would be asked, and refuse, every id the data store holds.
    if (pending.size > 0) await this.claimChildLinks(access, pending, result, false);
    if (pending.size > 0) await this.claimChildLinks(access, pending, result, true);

    // A listing needs the directory readable and reachable, as `children` does by path.
    const visible = await this.visibleIds(access, [...result.keys()]);
    for (const id of [...result.keys()]) if (!visible.has(id)) result.delete(id);
    return result;
  }

  /** One pass of `getChildLinksByIds` over this VFS and its mounts: the stores that know their ids, or (`blind`) the ones that do not. */
  private async claimChildLinks(access: Access, pending: Set<NodeId>, result: Map<NodeId, NodeChild[]>, blind: boolean): Promise<void> {
    const claim = (links: Map<NodeId, NodeChild[]>) => {
      for (const [id, children] of links) {
        if (!pending.has(id)) continue;
        result.set(id, children);
        pending.delete(id);
      }
    };
    const knowsItsIds = this.store.getChildLinksMany !== undefined || this.store.getParentLinksMany !== undefined;

    if (!blind && knowsItsIds) {
      if (this.store.getChildLinksMany) {
        claim(new Map([...await this.store.getChildLinksMany([...pending])].filter(([, children]) => children.length > 0)));
      }
      if (pending.size > 0 && this.store.getParentLinksMany) {
        const held = [...(await this.store.getParentLinksMany([...pending])).keys()];
        claim(this.store.getChildLinksMany ? new Map(held.map((id) => [id, []])) : await this.childLinksFor(held));
      }
    } else if (blind && !knowsItsIds) {
      claim(new Map([...await this.childLinksFor([...pending])].filter(([, children]) => children.length > 0)));
    }

    for (const mount of this.mountpoints) {
      if (pending.size === 0) return;
      if (mount.vfs instanceof LocalNodeVFS) await mount.vfs.claimChildLinks(access, pending, result, blind);
      else if (blind) claim(await mount.vfs.getChildLinksByIds(access, [...pending]));
    }
  }

  async resolveId(
    access: Access,
    id: NodeId,
  ): Promise<NodeEntry[]> {
    try {
      // A path inside a trash is not offered, as `pathsIn` does not offer one.
      return (await this.walkId(access, id)).filter((entry) => !isTrashPath(entry.absPath));
    } catch (error) {
      // Node not found in root store, recursively check mounted VFS instances
      for (const mount of this.mountpoints) {
        let entries: NodeEntry[];
        try {
          // Use resolveId to recursively search through sub-mounts
          entries = await mount.vfs.resolveId(access, id);
        } catch {
          // Not in this mount, continue to next
          continue;
        }

        // Found; whether the caller may follow a path to it is up to the mount point's ancestors.
        if (!(await this.mountReachable(access, mount))) return [];
        return entries.map((e) => ({
          ...e,
          absPath: join(mount.point.vfsAbsPath, e.absPath),
        }));
      }
      // Node not found anywhere, re-throw the original error
      throw error;
    }
  }

  /**
   * Every path to `id` in this store alone, walking parent edges up to the root and keeping only
   * those whose every directory grants `access` execute — the rule a path walk enforces on the way
   * down. Throws when the store does not hold `id`.
   */
  private async walkId(access: Access, id: NodeId): Promise<NodeEntry[]> {
    if (id === this.rootId) {
      return [
        {
          id,
          vfs: this,
          vfsAbsPath: '/',
          absPath: '/',
        },
      ];
    }

    if (!(await this.store.exists(id))) {
      throw new Error('not present on this VFS');
    }

    // Only the (parent, name) edges are needed, and a store that indexes them
    // answers without reading a parent node at all.
    const links = this.store.getParentLinks ? await this.store.getParentLinks(id) : (await Promise.all(
      (await this.store.getParents(id)).map(async (parent) =>
        (await this.store.getChildLinks(parent.id, { childId: id }))
          .map((child) => ({ parentId: parent.id, name: child.name }))
      ),
    )).flat();

    // Group by parent so each one is resolved once even when a node is
    // hard-linked under several names in the same directory.
    const byParent = new Map<NodeId, string[]>();
    for (const link of links) {
      const names = byParent.get(link.parentId);
      if (names) names.push(link.name);
      else byParent.set(link.parentId, [link.name]);
    }

    return (await Promise.all(
      [...byParent].map(async ([parentId, names]) => {
        if (!bypassesAccess(access)) {
          const parent = await this.store.getNode(parentId).catch(() => undefined);
          if (!parent || !verifyAccess(access, parent.props, 'x')) return [];
        }

        const entries: NodeEntry[] = [];
        for (const e of await this.walkId(access, parentId)) {
          for (const name of names) {
            entries.push({
              id: id,
              vfs: this,
              vfsAbsPath: join(e.vfsAbsPath, name),
              absPath: join(e.absPath, name),
            });
          }
        }

        return entries;
      }),
    )).flat();
  }

  async exists(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<boolean> {
    try {
      const entry = await this.resolveEntry(access, ref, opts);

      // Resolving the path has already asserted execute on every directory above it.
      if (entry.vfs === this) {
        return await this.store.exists(entry.id);
      }

      return await entry.vfs.exists(access, entry, opts);
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  async ensure<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    type: NodeType,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions & {
      props?: Partial<NodePropsCreate>;
      attrs?: T;
    },
  ): Promise<Node<T>> {
    return this.create<T>(access, type, parentRef, name, {
      ...opts,
      ensure: true,
    });
  }

  /**
   * Registry routing opts. The storage tier is a node prop, but registries
   * receive the attrs bag as `opts` and route via `tierOf`; merge `props.tier`
   * into it.
   */
  private tierOpts(node: Node): NodeAttrs {
    return { ...node.attrs, tier: node.props.tier };
  }

  async create<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    type: NodeType,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions & {
      props?: Partial<NodePropsCreate>;
      attrs?: T;
      ensure?: boolean;
    },
  ): Promise<Node<T>> {
    const entry = await this.resolveEntry(access, parentRef, opts);

    this.assertMountWritable(entry);

    if (entry.vfs !== this) {
      return await entry.vfs.create<T>(access, type, entry, name, opts);
    }

    const newNodePath = join(entry.vfsAbsPath, name);

    // `ensure` is nearly always a hit — a caller making sure the directory it
    // writes into on every pass is still there. Answer that from a plain read
    // rather than opening a transaction and taking the parent's lock to do the
    // same read inside it.
    const existing = opts?.ensure ? await this.getIfPresent<T>(access, newNodePath) : undefined;
    if (existing) return existing;

    const spec: NodeTreeSpec<T> = { type, name, props: opts?.props, attrs: opts?.attrs };

    try {
      const [created] = await this.createTreeAt<T>(access, entry, [spec]);
      return created as Node<T>;
    } catch (error) {
      // A concurrent creator won the window the fast path above leaves open.
      // `ensure` promises the node is there, not that this call is what put it
      // there.
      if (opts?.ensure && error instanceof NodeAlreadyExistsError) {
        const raced = await this.getIfPresent<T>(access, newNodePath);
        if (raced) return raced;
      }

      throw error;
    }
  }

  /**
   * Create a whole subtree under one existing parent, as one transaction: one
   * commit, one walk down the path and one pooled connection, however many
   * nodes the spec holds.
   *
   * Only `parentRef` is locked, and that is enough: every other parent in the
   * spec is created inside this transaction, so nothing outside it can name a
   * child under one before it commits.
   *
   * Events are delivered after the commit, so a subscriber that reacts to the
   * root node's `created` event never sees the subtree half-written.
   *
   * How much of it survives a failure part-way is the store's to say: a name
   * already taken takes the whole subtree with it on PgStore, while a store
   * with no real transaction (`NO_OP_TRANSACTION`) keeps whatever landed first.
   *
   * @returns the created top-level nodes, in spec order.
   */
  async createTree<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    parentRef: NodeReference,
    specs: NodeTreeSpec<T>[],
    opts?: NodeResolveOptions,
  ): Promise<Node<T>[]> {
    const entry = await this.resolveEntry(access, parentRef, opts);

    this.assertMountWritable(entry);

    if (entry.vfs !== this) {
      return await entry.vfs.createTree<T>(access, entry, specs, opts);
    }

    return await this.createTreeAt<T>(access, entry, specs);
  }

  /** `createTree` with the parent already resolved and known to be ours. */
  private async createTreeAt<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    entry: NodeEntry,
    specs: NodeTreeSpec<T>[],
  ): Promise<Node<T>[]> {
    if (!this.store.createNode) {
      throw new NodeInvalidOperationError('create is not supported on this system backend');
    }

    if (specs.length === 0) return [];

    return await this.withTransaction([entry.id], async (mut) => {
      const parent = await this.store.getNode(entry.id, mut.tx);

      return await this.createChildren<T>(access, mut, entry, parent, specs);
    });
  }

  /** One level of a `createTree`, then its own children. Depth first, in order. */
  private async createChildren<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    mut: Mutation,
    parentEntry: NodeEntry,
    parent: Node,
    specs: NodeTreeSpec<T>[],
  ): Promise<Node<T>[]> {
    // Write and execute on the directory being written into, at every level.
    // The deeper ones cost nothing to check: the node was just returned by the
    // create above it.
    assertAccess(access, parent, 'w');
    assertAccess(access, parent, 'x');

    const planned = specs.map((spec) => {
      const path = join(parentEntry.vfsAbsPath, spec.name);

      // Owned by its creator, grouped with the node it is created in — Linux's setgid directory,
      // for every node, since here any node can hold children. A family album's uploads and the
      // faces, thumbnails and metadata the pipeline adds under them stay in the album's group
      // whoever made them, and a private area's stay in its owner's. Others see it only as far as
      // they could see the parent. The parent's access list comes along, the way a Linux default
      // ACL does, so a person, group or share link granted the album sees what is added to it.
      // An administrator's access that creates in someone's name (`Access.creator`) records the
      // node as created by them.
      const props: NodePropsCreate = {
        mode: modeUnder(parent.props.mode),
        uid: access.uid,
        gid: parent.props.gid,
        ...(parent.props.acl?.length ? { acl: parent.props.acl } : {}),
        ...(access.creator !== undefined && isAdmin(access) ? { birthtime: { uid: access.creator, timestamp: Date.now() } } : {}),
        ...(spec.props || {}),
      };
      assertOwnershipAllowed(access, path, { uid: access.uid, gid: parent.props.gid }, spec.props);
      assertIdentityCreatable(access, path, spec.type);
      this.declareWrite(mut, spec.type);
      return { spec, path, props };
    });

    // Node, attrs and the edge naming it under the parent in one store call — every sibling in
    // one where the store can. A name collision comes back from the store's own uniqueness
    // constraint, so nothing reads the parent's children first.
    const nodes: Node<T>[] = [];
    if (planned.length > 1 && this.store.createNodes) {
      nodes.push(
        ...await this.store.createNodes<T>(access.uid, parent.id, planned.map(({ spec, props }) => ({ type: spec.type, name: spec.name, props, attrs: spec.attrs })), mut.tx),
      );
    } else {
      for (const { spec, props } of planned) nodes.push(await this.store.createNode!<T>(access.uid, spec.type, parent.id, spec.name, props, spec.attrs, mut.tx));
    }

    for (const [i, { spec, path }] of planned.entries()) {
      const node = nodes[i];

      // Physical storage once the node is committed, so a name that lost the
      // race, or a subtree rolled back part-way, leaves no orphaned bytes behind.
      const reg = this.regs[spec.type as keyof VfsRegistries];
      if (reg) {
        const id = this.store.pathAddressed ? path : node.id;
        mut.afterCommit(async () => {
          try {
            await reg.touch(id, this.tierOpts(node) as any);
          } catch (error) {
            if (!(error instanceof NodeNotSupportedError)) {
              logger.error('resource touch failed on create', { error, nodeId: node.id });
            }
          }
        });
      }

      mut.emit('created', path, node, undefined, access.uid);
      mut.audit(access, { op: 'create', node, path });
      // The parent, not the child: `child-attached` is a fact about the container,
      // as `child-detached` is. The child's own `created` event carries the child.
      mut.emit('child-attached', parentEntry.vfsAbsPath, parent, undefined, access.uid);

      if (spec.children?.length) {
        const childEntry: NodeEntry = {
          id: node.id,
          vfs: this,
          vfsAbsPath: path,
          absPath: join(parentEntry.absPath || parentEntry.vfsAbsPath, spec.name),
        };

        await this.createChildren(access, mut, childEntry, node, spec.children as NodeTreeSpec<T>[]);
      }
    }

    return nodes;
  }

  /** `get`, but a missing node is `undefined` rather than a throw. */
  private async getIfPresent<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    path: NodePath,
  ): Promise<Node<T> | undefined> {
    try {
      return await this.get<T>(access, path, { readlink: true });
    } catch (error) {
      if (error instanceof NodeNotFoundError) return undefined;
      throw error;
    }
  }

  async update<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      props?: NodePropsUpdate;
      attrs?: NodeAttrsUpdate<T>;
    },
  ): Promise<Node<T>> {
    const entry = await this.resolveEntry(access, ref, opts);

    this.assertMountWritable(entry);

    if (entry.vfs === this) {
      if (!this.store.updateNode) {
        throw new NodeInvalidOperationError('update is not supported on this system backend');
      }

      // Lock the node being updated
      return await this.withTransaction([entry.id], async (mut) => {
        const previousNode = await this.store.getNode<T>(entry.id, mut.tx);
        this.assertUpdatable(access, previousNode, opts?.props, opts?.attrs);
        this.declareWrite(mut, previousNode.type);

        const updatedNode = await this.store.updateNode!<T>(access.uid, entry.id, opts?.props, opts?.attrs, mut.tx);

        this.updated(access, mut, entry, previousNode, updatedNode, opts?.attrs);

        return updatedNode;
      });
    }

    return await entry.vfs.update<T>(access, entry, opts);
  }

  async updateMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    refs: NodeReference[],
    opts: UpdateManyOptions<T> = {},
  ): Promise<PromiseSettledResult<Node<T>>[]> {
    return await this.byOwner(access, refs, opts, (entry) => this.assertMountWritable(entry), (vfs, entries) => {
      return vfs === this ? this.updateBatches<T>(access, entries, opts) : vfs.updateMany<T>(access, entries, opts);
    });
  }

  async updateEach<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    changes: NodeChange<T>[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<PromiseSettledResult<Node<T>>[]> {
    const results: PromiseSettledResult<Node<T>>[] = new Array(changes.length);
    const owners = new Map<NodeVFS, { index: number; entry: NodeEntry; change: NodeChange<T> }[]>();
    const plain = await this.plainEntries(access, changes.map((change) => ({ ref: change.ref, opts: change })));

    for (const [index, change] of changes.entries()) {
      try {
        const entry = plain[index] ?? await this.resolveEntry(access, change.ref, change);
        this.assertMountWritable(entry);
        owners.set(entry.vfs, [...owners.get(entry.vfs) ?? [], { index, entry, change }]);
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }

    for (const [vfs, items] of owners) {
      const settled = vfs === this
        ? await this.updateEachBatches<T>(access, items, opts)
        : await vfs.updateEach<T>(access, items.map(({ entry, change }) => ({ ref: entry, props: change.props, attrs: change.attrs })), opts);
      items.forEach((item, i) => {
        results[item.index] = settled[i];
      });
    }

    return results;
  }

  /**
   * The entries of the paths among `refs` that a batch can find: those sharing a directory with
   * another, each directory resolved once and its named children read together — the edges in one
   * read and their nodes in another, here or in the VFS mounted there. Only a plain node is
   * answered: a path through `!`, onto a mount point or a softlink to follow, under a directory
   * the caller may not search, or not there, is left undefined, as is every other ref, for
   * `resolveEntry` to resolve and to refuse as it does.
   */
  private async plainEntries(access: Access, refs: { ref: NodeReference; opts?: NodeResolveOptions }[]): Promise<(NodeEntry | undefined)[]> {
    const entries: (NodeEntry | undefined)[] = new Array(refs.length);
    const dirs = new Map<string, { dir: NodePath; follow: boolean; readlink: boolean; items: { index: number; name: string }[] }>();
    for (const [index, { ref, opts }] of refs.entries()) {
      if (typeof ref !== 'string' || ref.startsWith('!') || opts?.readmount) continue;
      const path = this.normalizePath(ref);
      if (path === '/') continue;
      const follow = opts?.follow !== false;
      const readlink = opts?.readlink ?? false;
      const key = `${follow}\0${readlink}\0${dirname(path)}`;
      const group = dirs.get(key) ?? { dir: dirname(path), follow, readlink, items: [] };
      group.items.push({ index, name: basename(path) });
      dirs.set(key, group);
    }

    const local: { parent: NodeEntry; group: { readlink: boolean; follow: boolean; items: { index: number; name: string }[] } }[] = [];
    for (const group of dirs.values()) {
      if (group.items.length < 2) continue;
      const parent = await this.resolvePath(access, group.dir, { follow: group.follow }).catch(() => undefined);
      if (!parent) continue;
      if (parent.vfs === this) {
        local.push({ parent, group });
        continue;
      }
      if (!(parent.vfs instanceof LocalNodeVFS)) continue;
      const found = await parent.vfs.plainEntries(
        access,
        group.items.map((item) => ({ ref: join(parent.vfsAbsPath, item.name), opts: { follow: group.follow, readlink: group.readlink } })),
      );
      group.items.forEach((item, i) => {
        const entry = found[i];
        if (entry) entries[item.index] = { ...entry, absPath: join(parent.absPath, item.name) };
      });
    }
    if (local.length === 0) return entries;

    const edges = await this.namedEdges(local.flatMap(({ parent, group }) => group.items.map((item) => ({ parentId: parent.id, name: item.name }))));
    const nodes = await this.readNodes([...new Set([...local.map(({ parent }) => parent.id), ...edges.values()])]);
    for (const { parent, group } of local) {
      const dir = nodes.get(parent.id);
      if (!dir || !verifyAccess(access, dir.props, 'x')) continue;
      for (const item of group.items) {
        const id = edges.get(edgeKey(parent.id, item.name));
        const node = id === undefined ? undefined : nodes.get(id);
        if (!node || this.mountpoints.some((mount) => mount.point.id === id)) continue;
        if (node.props.softlink && group.follow && !group.readlink) continue;
        entries[item.index] = { id: node.id, vfs: this, vfsAbsPath: join(parent.vfsAbsPath, item.name), absPath: join(parent.absPath, item.name) };
      }
    }
    return entries;
  }

  /**
   * A batched operation over refs that may lie in several VFSs: each ref is resolved and handed,
   * with the others its node's VFS holds, to `run` — this VFS's own batch, or a mount's. A ref
   * that does not resolve, or that `check` refuses, fails in its own slot.
   *
   * @returns one result per ref, in order.
   */
  private async byOwner<R>(
    access: Access,
    refs: NodeReference[],
    opts: NodeResolveOptions | undefined,
    check: ((entry: NodeEntry) => void) | undefined,
    run: (vfs: NodeVFS, entries: NodeEntry[]) => Promise<PromiseSettledResult<R>[]>,
  ): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(refs.length);
    const owners = new Map<NodeVFS, { index: number; entry: NodeEntry }[]>();
    const plain = await this.plainEntries(access, refs.map((ref) => ({ ref, opts })));

    for (const [index, ref] of refs.entries()) {
      try {
        const entry = plain[index] ?? await this.resolveEntry(access, ref, opts);
        check?.(entry);

        const owned = owners.get(entry.vfs) ?? [];
        owned.push({ index, entry });
        owners.set(entry.vfs, owned);
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }

    for (const [vfs, owned] of owners) {
      const settled = await run(vfs, owned.map((item) => item.entry));
      owned.forEach((item, i) => {
        results[item.index] = settled[i];
      });
    }

    return results;
  }

  /** `updateMany` over entries of this VFS's own, one transaction per `WRITE_BATCH` of them. */
  private async updateBatches<T extends NodeAttrs>(
    access: Access,
    entries: NodeEntry[],
    opts: UpdateManyOptions<T>,
  ): Promise<PromiseSettledResult<Node<T>>[]> {
    const results: PromiseSettledResult<Node<T>>[] = new Array(entries.length);

    if (!this.store.updateNode) {
      const reason = new NodeInvalidOperationError('update is not supported on this system backend');
      return results.fill({ status: 'rejected', reason });
    }

    for (let start = 0; start < entries.length; start += WRITE_BATCH) {
      if (opts.signal?.aborted) {
        results.fill({ status: 'rejected', reason: opts.signal.reason }, start);
        break;
      }

      const batch = entries.slice(start, start + WRITE_BATCH);

      // Refusals are known before anything is written, so they stand whatever becomes of the rest.
      const refused = new Map<NodeId, unknown>();

      let written: Map<NodeId, Node<T>>;
      try {
        written = await this.withTransaction(batch.map((entry) => entry.id), (mut) => this.updateBatch<T>(access, mut, batch, opts, refused));
      } catch (error) {
        // Rolled back: nothing in the batch was written.
        written = new Map();
        for (const entry of batch) {
          if (!refused.has(entry.id)) refused.set(entry.id, error);
        }
      }

      batch.forEach((entry, i) => {
        const node = written.get(entry.id);
        results[start + i] = node ? { status: 'fulfilled', value: node } : { status: 'rejected', reason: refused.get(entry.id) };
      });
    }

    return results;
  }

  /**
   * One batch of `updateMany`, under its locks and in its transaction: `update`'s checks on every
   * node, then one store write for those that pass. A node that does not pass is put in
   * `refused` and left out; the rest are written and returned.
   *
   * A node reached by two entries (a hard link) is written once, and announced under the first.
   */
  private async updateBatch<T extends NodeAttrs>(
    access: Access,
    mut: Mutation,
    batch: NodeEntry[],
    opts: UpdateManyOptions<T>,
    refused: Map<NodeId, unknown>,
  ): Promise<Map<NodeId, Node<T>>> {
    const entries = new Map<NodeId, NodeEntry>();
    for (const entry of batch) {
      if (!entries.has(entry.id)) entries.set(entry.id, entry);
    }

    const previous = await this.readNodes<T>([...entries.keys()], mut.tx);

    const accepted: NodeId[] = [];
    for (const [id, entry] of entries) {
      try {
        const node = previous.get(id);
        if (!node) {
          throw new NodeNotFoundError(entry.absPath || entry.vfsAbsPath);
        }

        this.assertUpdatable(access, node, opts.props, opts.attrs);
        opts.guard?.(node);
        this.declareWrite(mut, node.type);
        accepted.push(id);
      } catch (error) {
        refused.set(id, error);
      }
    }

    const written = await this.updateNodesIn<T>(mut, access.uid, accepted, opts.props, opts.attrs, refused);
    for (const id of accepted) {
      if (!written.has(id) && !refused.has(id)) {
        const entry = entries.get(id)!;
        refused.set(id, new NodeNotFoundError(entry.absPath || entry.vfsAbsPath));
      }
    }

    for (const [id, node] of written) {
      // The batched read carries no link count, and an update does not change it.
      const before = previous.get(id)!;
      const previousNode = { ...before, props: { ...before.props, count: node.props.count } };

      this.updated(access, mut, entries.get(id)!, previousNode, node, opts.attrs);
    }

    return written;
  }

  /**
   * Many nodes by id, in one read where the store can; inside a transaction, under its row locks.
   * An id with no node is absent.
   */
  private async readNodes<T extends NodeAttrs>(ids: NodeId[], tx?: Transaction): Promise<Map<NodeId, Node<T>>> {
    if (this.store.getNodes) {
      return await this.store.getNodes<T>(ids, tx);
    }

    const nodes = new Map<NodeId, Node<T>>();
    for (const id of ids) {
      try {
        nodes.set(id, await this.store.getNode<T>(id, tx));
      } catch (error) {
        if (!(error instanceof NodeNotFoundError)) throw error;
      }
    }
    return nodes;
  }

  /**
   * One store write for a batch's accepted nodes; a node that is gone is absent. Without the store's
   * batched form each node is written alone; those stores keep no transaction, so one node's
   * failure is that node's, put in `refused`, and the rest go on.
   */
  private async updateNodesIn<T extends NodeAttrs>(
    mut: Mutation,
    uid: UserId,
    ids: NodeId[],
    props: NodePropsUpdate | undefined,
    attrs: NodeAttrsUpdate<T> | undefined,
    refused: Map<NodeId, unknown>,
  ): Promise<Map<NodeId, Node<T>>> {
    if (ids.length === 0) {
      return new Map();
    }

    if (this.store.updateNodes) {
      return await this.store.updateNodes<T>(uid, ids, props, attrs, mut.tx);
    }

    const written = new Map<NodeId, Node<T>>();
    for (const id of ids) {
      try {
        written.set(id, await this.store.updateNode!<T>(uid, id, props, attrs, mut.tx));
      } catch (error) {
        refused.set(id, error);
      }
    }
    return written;
  }

  /**
   * `updateEach` over entries of this VFS's own, one transaction per batch. A batch is at most
   * `WRITE_BATCH` changes, and ends before a node it already changes, so a node's changes are made
   * in order.
   */
  private async updateEachBatches<T extends NodeAttrs>(
    access: Access,
    items: { entry: NodeEntry; change: NodeChange<T> }[],
    opts: { signal?: AbortSignal },
  ): Promise<PromiseSettledResult<Node<T>>[]> {
    const results: PromiseSettledResult<Node<T>>[] = new Array(items.length);

    if (!this.store.updateNode) {
      const reason = new NodeInvalidOperationError('update is not supported on this system backend');
      return results.fill({ status: 'rejected', reason });
    }

    for (let start = 0; start < items.length;) {
      if (opts.signal?.aborted) {
        results.fill({ status: 'rejected', reason: opts.signal.reason }, start);
        break;
      }

      const ids = new Set<NodeId>();
      let end = start;
      while (end < items.length && end - start < WRITE_BATCH && !ids.has(items[end].entry.id)) ids.add(items[end++].entry.id);
      const batch = items.slice(start, end);

      // Refusals are known before anything is written, so they stand whatever becomes of the rest.
      const refused = new Map<NodeId, unknown>();
      let written: Map<NodeId, Node<T>>;
      try {
        written = await this.withTransaction([...ids], (mut) => this.updateEachBatch<T>(access, mut, batch, refused));
      } catch (error) {
        // Rolled back: nothing in the batch was written.
        written = new Map();
        for (const id of ids) {
          if (!refused.has(id)) refused.set(id, error);
        }
      }

      batch.forEach(({ entry }, i) => {
        const node = written.get(entry.id);
        results[start + i] = node
          ? { status: 'fulfilled', value: node }
          : { status: 'rejected', reason: refused.get(entry.id) ?? new NodeNotFoundError(entry.absPath || entry.vfsAbsPath) };
      });
      start = end;
    }

    return results;
  }

  /** One batch of `updateEach`, under its locks and in its transaction: `update`'s checks on every node, then one store write. */
  private async updateEachBatch<T extends NodeAttrs>(
    access: Access,
    mut: Mutation,
    batch: { entry: NodeEntry; change: NodeChange<T> }[],
    refused: Map<NodeId, unknown>,
  ): Promise<Map<NodeId, Node<T>>> {
    const previous = await this.readNodes<T>(batch.map(({ entry }) => entry.id), mut.tx);

    const accepted: NodeUpdate<T>[] = [];
    for (const { entry, change } of batch) {
      try {
        const node = previous.get(entry.id);
        if (!node) throw new NodeNotFoundError(entry.absPath || entry.vfsAbsPath);
        this.assertUpdatable(access, node, change.props, change.attrs);
        this.declareWrite(mut, node.type);
        accepted.push({ id: entry.id, props: change.props, attrs: change.attrs });
      } catch (error) {
        refused.set(entry.id, error);
      }
    }

    const written = await this.writeEach<T>(mut, access.uid, accepted, (id, error) => refused.set(id, error));
    for (const { entry, change } of batch) {
      const node = written.get(entry.id);
      if (!node) continue;
      // The batched read carries no link count, and an update does not change it.
      const before = previous.get(entry.id)!;
      this.updated(access, mut, entry, { ...before, props: { ...before.props, count: node.props.count } }, node, change.attrs);
    }

    return written;
  }

  /**
   * One store write for many nodes, each with its own change; a node that is gone is absent.
   * Without the store's batched form each node is written alone, and one that fails is handed to
   * `refuse` while the rest go on.
   */
  private async writeEach<T extends NodeAttrs>(
    mut: Mutation,
    uid: UserId,
    changes: NodeUpdate<T>[],
    refuse: (id: NodeId, error: unknown) => void,
  ): Promise<Map<NodeId, Node<T>>> {
    if (changes.length === 0) return new Map();
    if (this.store.updateNodesEach) return await this.store.updateNodesEach<T>(uid, changes, mut.tx);

    const written = new Map<NodeId, Node<T>>();
    for (const change of changes) {
      try {
        written.set(change.id, await this.store.updateNode!<T>(uid, change.id, change.props, change.attrs, mut.tx));
      } catch (error) {
        refuse(change.id, error);
      }
    }
    return written;
  }

  /** What `update` asks of a node, read under its lock, before writing it. */
  private assertUpdatable(access: Access, node: Node, props?: NodePropsUpdate, attrs?: NodeAttrsUpdate): void {
    assertAccess(access, node, 'w');
    assertIdentityUnchanged(access, node, props, attrs);
    assertOwnerAttrsUnchanged(access, node, attrs);
    assertOwnershipAllowed(access, node.id, node.props, props);

    // Storage tier is set once at creation and immutable thereafter: the
    // bytes physically live on their tier, so changing it strands them.
    // Re-sending the identical value is a no-op so callers may resend props.
    if (props?.tier !== undefined && props.tier !== node.props.tier) {
      throw new NodeTierImmutableError(node.id);
    }
  }

  /** What follows a node's update: its storage synced once committed, its event and its record. */
  private updated(access: Access, mut: Mutation, entry: NodeEntry, previousNode: Node, node: Node, attrs?: NodeAttrsUpdate): void {
    // A registry's options are the node's attrs and its tier, and the tier never changes: an
    // update that leaves the attrs alone has nothing to sync.
    const reg = attrs ? this.regs[node.type as keyof VfsRegistries] : undefined;
    if (reg) {
      const id = this.store.pathAddressed ? entry.vfsAbsPath : entry.id;
      mut.afterCommit(async () => {
        try {
          await reg.touch(id, this.tierOpts(node) as any);
        } catch (error) {
          if (!(error instanceof NodeNotSupportedError)) {
            logger.error('resource touch failed on update', { error, nodeId: node.id });
          }
        }
      });
    }

    mut.emit('updated', entry.vfsAbsPath, node, previousNode, access.uid);
    mut.audit(access, { op: 'update', node, path: entry.vfsAbsPath, previousNode });
  }

  async rename<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    oldParentRef: NodeReference,
    oldName: string,
    newParentRef: NodeReference,
    newName: string,
    opts?: NodeResolveOptions & { failIfExists?: boolean },
  ): Promise<Node<T>> {
    const oldParentEntry = await this.resolveEntry(access, oldParentRef, { follow: opts?.follow });
    const newParentEntry = await this.resolveEntry(access, newParentRef, { follow: opts?.follow });

    this.assertMountWritable(oldParentEntry);
    this.assertMountWritable(newParentEntry);

    if (oldParentEntry.vfs === this && newParentEntry.vfs === this) {
      if (!this.store.moveChild) {
        throw new NodeInvalidOperationError('rename is not supported on this system backend');
      }

      const moveChild = this.store.moveChild.bind(this.store);

      this.assertNoMountWithin(join(oldParentEntry.vfsAbsPath, oldName), join(oldParentEntry.absPath || oldParentEntry.vfsAbsPath, oldName));

      // First, find the child to get its ID for locking
      const [child] = await this.store.getChildLinks(oldParentEntry.id, { name: oldName });
      if (!child) {
        throw new NodeNotFoundError(`${oldName} in parent`);
      }

      // A node already at the destination name is replaced, so it is locked too
      const [taken] = await this.store.getChildLinks(newParentEntry.id, { name: newName });

      // Lock all affected nodes: old parent, new parent (if different), the node being moved, and
      // the one it replaces
      const nodeIdsToLock = [oldParentEntry.id, child.id];
      if (oldParentEntry.id !== newParentEntry.id) {
        nodeIdsToLock.push(newParentEntry.id);
      }
      if (taken && taken.id !== child.id) {
        nodeIdsToLock.push(taken.id);
      }

      return this.withTransaction(nodeIdsToLock, async (mut) => {
        // Re-read nodes with locks held
        const oldParent = await this.store.getNode(oldParentEntry.id, mut.tx);
        assertAccess(access, oldParent, 'w');
        assertAccess(access, oldParent, 'x');

        // Re-find the child (state may have changed)
        const [childEntry] = await this.store.getChildLinks(oldParent.id, { name: oldName }, mut.tx);
        if (!childEntry) {
          throw new NodeNotFoundError(`${oldName} in parent`);
        }

        const node = await this.store.getNode<T>(childEntry.id, mut.tx);
        assertAccess(access, node, 'w');

        const newParent = oldParentEntry.id === newParentEntry.id ? oldParent : await this.store.getNode(newParentEntry.id, mut.tx);
        assertAccess(access, newParent, 'w');
        assertAccess(access, newParent, 'x');

        const [dest] = await this.store.getChildLinks(newParent.id, { name: newName }, mut.tx);
        if (dest) {
          if (opts?.failIfExists) {
            throw new NodeAlreadyExistsError(newParentEntry.id, newName);
          }

          // Both names already lead to the node, its own or a hard link: nothing changes
          if (dest.id === childEntry.id) {
            return node;
          }

          // Replaced since the locks were chosen: the new occupant is not locked
          if (dest.id !== taken?.id) {
            throw new NodeAlreadyExistsError(newParentEntry.id, newName);
          }

          await this.replaceForMove(access, mut, newParentEntry, dest.id, join(newParentEntry.vfsAbsPath, newName));
        }

        // One edge moves; the siblings are not touched
        await moveChild(access.uid, oldParent.id, oldName, newParent.id, newName, mut.tx);

        // A path-addressed store gives the node a new id at its new path
        const movedId = this.store.pathAddressed ? (await this.store.getChildLinks(newParent.id, { name: newName }, mut.tx))[0]?.id ?? childEntry.id : childEntry.id;
        const movedNode = await this.store.getNode<T>(movedId, mut.tx);

        // Build old and new VFS paths
        const oldPath = join(oldParentEntry.vfsAbsPath, oldName);
        const newPath = join(newParentEntry.vfsAbsPath, newName);
        const newVfsPath = join(newParentEntry.absPath || newParentEntry.vfsAbsPath, newName);

        const newEntry: NodeEntry = {
          id: movedId,
          vfs: this,
          vfsAbsPath: newPath,
          absPath: newVfsPath,
        };

        // Emit child-detached from old parent (pass parent node for type info)
        mut.emit('child-detached', oldParentEntry.vfsAbsPath, oldParent, undefined, access.uid);

        mut.emit('moved', newEntry.vfsAbsPath, movedNode, movedNode, access.uid, oldPath);
        mut.audit(access, { op: 'move', node: movedNode, path: newPath, fromPath: oldPath });

        // Emit child-attached to new parent (only if different parent)
        if (oldParent.id !== newParent.id) {
          mut.emit('child-attached', newParentEntry.vfsAbsPath, newParent, undefined, access.uid);
        }

        return movedNode;
      });
    }

    if (oldParentEntry.vfs !== newParentEntry.vfs) {
      return await this.moveAcross<T>(access, oldParentEntry, oldName, newParentEntry, newName, opts?.failIfExists);
    }

    return await oldParentEntry.vfs.rename<T>(access, oldParentEntry, oldName, newParentEntry, newName, opts);
  }

  /**
   * Refuse to move or remove `vfsPath` while one of this VFS's mounts stands at or under it, as
   * Unix answers `EBUSY`: a mount keeps the path it was mounted at, for `mounts` and for its events.
   * The error names the mount point under `callerPath`, the same node in the caller's paths, which
   * differ when an outer VFS passed the entry down.
   */
  private assertNoMountWithin(vfsPath: NodePath, callerPath: NodePath): void {
    const mounted = this.mountpoints.find((m) => isPathWithin(m.point.vfsAbsPath, vfsPath));
    if (mounted) {
      throw new NodeBusyError(join(callerPath, relative(vfsPath, mounted.point.vfsAbsPath)));
    }
  }

  /**
   * Make room for a move onto a taken name, as Unix `rename` does: the node there goes, unless it
   * has children. A path-addressed store replaces it itself when it moves the edge, and removing it
   * here would also remove the registry content the moved node takes over at that path.
   */
  private async replaceForMove(access: Access, mut: Mutation, parentEntry: NodeEntry, destId: NodeId, destPath: NodePath): Promise<void> {
    if ((await this.store.getChildLinks(destId, undefined, mut.tx)).length > 0) {
      throw new NodeInvalidOperationError(`cannot replace '${destPath}': it has children`);
    }

    const dest = await this.store.getNode(destId, mut.tx);
    assertAccess(access, dest, 'w');

    if (!this.store.pathAddressed) {
      await this.detachEdge(access, mut, parentEntry, destId, destPath);
    }
  }

  /**
   * Move a node between two VFS backends, where no edge can move: copy its whole tree, then remove
   * the source. The copy is a new node. A softlink moves as the link itself, never followed. A node already at the destination name is replaced, unless
   * it has children or `failIfExists` is set. If removing the source fails part-way, the copy stays
   * and so does what is left of the source.
   */
  private async moveAcross<T extends NodeAttrs>(
    access: Access,
    oldParentEntry: NodeEntry,
    oldName: string,
    newParentEntry: NodeEntry,
    newName: string,
    failIfExists?: boolean,
  ): Promise<Node<T>> {
    const oldParent = await oldParentEntry.vfs.get(access, oldParentEntry.vfsAbsPath);
    assertAccess(access, oldParent, 'w');
    assertAccess(access, oldParent, 'x');

    const sourcePath = join(oldParentEntry.vfsAbsPath, oldName);
    assertAccess(access, await oldParentEntry.vfs.get(access, sourcePath, { follow: false }), 'w');

    // Before the copy: removing the source would refuse only once the copy is made. `mounts` lists
    // the points in the source VFS's own paths, its nested mounts included.
    const mounted = oldParentEntry.vfs.mounts(access).find((m) => isPathWithin(m.point.absPath, sourcePath));
    if (mounted) {
      throw new NodeBusyError(join(oldParentEntry.absPath || oldParentEntry.vfsAbsPath, oldName, relative(sourcePath, mounted.point.absPath)));
    }

    const destPath = join(newParentEntry.vfsAbsPath, newName);
    if (await newParentEntry.vfs.exists(access, destPath, { follow: false })) {
      if (failIfExists) {
        throw new NodeAlreadyExistsError(newParentEntry.id, newName);
      }
      if (await newParentEntry.vfs.childCount(access, destPath, { follow: false, all: true }) > 0) {
        throw new NodeInvalidOperationError(`cannot replace '${destPath}': it has children`);
      }
    }

    const sourceEntry = await oldParentEntry.vfs.resolveEntry(access, sourcePath, { follow: false });
    const moved = await this.copy<T>(access, sourceEntry, newParentEntry, newName, { recursive: true, overwrite: true, follow: false });
    await oldParentEntry.vfs.unlink(access, sourcePath, oldParentEntry.vfsAbsPath, { recursive: true, follow: false });

    return moved;
  }

  async renameMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    moves: RenameMove[],
    opts: RenameManyOptions = {},
  ): Promise<PromiseSettledResult<RenamedNode<T>>[]> {
    const results: PromiseSettledResult<RenamedNode<T>>[] = new Array(moves.length);
    const made: PlannedMove[] = [];

    for (let start = 0; start < moves.length; start += WRITE_BATCH) {
      if (opts.signal?.aborted) {
        results.fill({ status: 'rejected', reason: opts.signal.reason }, start);
        break;
      }

      const planned = await this.planMoves(access, moves.slice(start, start + WRITE_BATCH), start, results);

      const own: PlannedMove[] = [];
      const mounted = new Map<NodeVFS, PlannedMove[]>();
      for (const move of planned) {
        const vfs = move.fromParent.vfs;
        if (vfs !== move.toParent.vfs) continue;
        if (vfs === this) own.push(move);
        else mounted.set(vfs, [...mounted.get(vfs) ?? [], move]);
      }

      if (own.length > 0) await this.renameChunk<T>(access, own, opts, results);

      for (const [vfs, group] of mounted) {
        const settled = await vfs.renameMany<T>(
          access,
          group.map(({ fromParent, fromName, toParent, toName }) => ({ fromParent, fromName, toParent, toName })),
          opts,
        );
        group.forEach((move, i) => {
          results[move.index] = settled[i];
        });
      }

      // Between two stores no edge can move: `rename` copies the tree and removes the source, and
      // the links follow below.
      for (const move of planned) {
        if (move.fromParent.vfs === move.toParent.vfs) continue;
        try {
          const node = await this.rename<T>(access, move.fromParent, move.fromName, move.toParent, move.toName, { failIfExists: opts.failIfExists });
          results[move.index] = { status: 'fulfilled', value: { node, relinked: 0 } };
        } catch (reason) {
          results[move.index] = { status: 'rejected', reason };
        }
      }

      for (const move of planned) {
        const result = results[move.index];
        if (result?.status === 'fulfilled' && !result.value.already) made.push(move);
      }
    }

    // The outermost VFS reaches every store, so it is the one that re-points what no chunk could.
    if (opts.relink !== false && !this.mounted && made.length > 0) {
      await this.relinkElsewhere(access, made, results);
    }

    return results;
  }

  /**
   * A chunk's moves with both parents resolved, each parent once. A move that cannot be made at
   * all — a parent that does not resolve or is on a read-only mount, the root itself — gets its
   * result here and is left out.
   */
  private async planMoves<T extends NodeAttrs>(
    access: Access,
    chunk: RenameMove[],
    start: number,
    results: PromiseSettledResult<RenamedNode<T>>[],
  ): Promise<PlannedMove[]> {
    const parents = new Map<NodePath, Promise<NodeEntry>>();
    const parent = (path: NodePath): Promise<NodeEntry> => {
      let entry = parents.get(path);
      if (!entry) {
        entry = this.resolveEntry(access, path);
        parents.set(path, entry);
      }
      return entry;
    };

    const planned: PlannedMove[] = [];
    for (const [i, move] of chunk.entries()) {
      const index = start + i;
      try {
        let ends: Pick<PlannedMove, 'fromParent' | 'fromName' | 'toParent' | 'toName'>;
        if ('from' in move) {
          const from = this.normalizePath(move.from);
          const to = this.normalizePath(move.to);
          if (from === '/' || to === '/') throw new NodeInvalidOperationError('cannot move the root');
          const [fromParent, toParent] = await Promise.all([parent(dirname(from)), parent(dirname(to))]);
          ends = { fromParent, fromName: basename(from), toParent, toName: basename(to) };
        } else {
          ends = move;
        }

        this.assertMountWritable(ends.fromParent);
        this.assertMountWritable(ends.toParent);

        planned.push({
          index,
          ...ends,
          from: join(ends.fromParent.absPath || ends.fromParent.vfsAbsPath, ends.fromName),
          to: join(ends.toParent.absPath || ends.toParent.vfsAbsPath, ends.toName),
        });
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }

    return planned;
  }

  /**
   * One chunk of `renameMany` within this VFS's own store. Its moves are screened against each
   * other, their edges and the links to re-point are read, and they are made in one transaction
   * under the whole lock set. A link that appeared between the read and the locks means the lock
   * set was short of it, so the chunk is read and tried once more.
   */
  private async renameChunk<T extends NodeAttrs>(
    access: Access,
    moves: PlannedMove[],
    opts: RenameManyOptions,
    results: PromiseSettledResult<RenamedNode<T>>[],
  ): Promise<void> {
    const reject = (move: PlannedMove, reason: unknown) => {
      results[move.index] = { status: 'rejected', reason };
    };

    if (!this.store.moveChild && !this.store.moveChildren) {
      const reason = new NodeInvalidOperationError('rename is not supported on this system backend');
      for (const move of moves) reject(move, reason);
      return;
    }

    const screened = this.screenMoves(moves, reject);

    for (let attempt = 0;; attempt++) {
      const plan = await this.readMoves<T>(screened, opts, results);
      if (plan.moves.length === 0) return;

      // Refusals are known before anything is written, so they stand whatever becomes of the rest.
      const refused = new Map<number, unknown>();
      try {
        const done = await this.withTransaction([...plan.nodeIds, ...plan.linkIds], (mut) => this.moveBatch<T>(access, mut, plan, opts, refused));
        for (const move of plan.moves) {
          const value = done.get(move.index);
          results[move.index] = value ? { status: 'fulfilled', value } : { status: 'rejected', reason: refused.get(move.index) };
        }
        return;
      } catch (error) {
        if (error instanceof LinksChangedError && attempt === 0) continue;
        // Rolled back: nothing in the chunk was written.
        for (const move of plan.moves) reject(move, refused.get(move.index) ?? error);
        return;
      }
    }
  }

  /**
   * The moves of a chunk that can be made together, as the paths say before anything is read:
   * none into its own subtree, from under a mount point, onto a name another move takes or leaves,
   * or into a tree another move takes away. Each source once.
   */
  private screenMoves(moves: PlannedMove[], reject: (move: PlannedMove, reason: unknown) => void): PlannedMove[] {
    const sources = new Map<string, PlannedMove>();
    for (const move of moves) {
      const key = edgeKey(move.fromParent.id, move.fromName);
      if (!sources.has(key)) sources.set(key, move);
    }
    const sourcePaths = new Map(moves.map((move) => [move.from, move]));

    const claimed = new Set<string>();
    const kept: PlannedMove[] = [];
    for (const move of moves) {
      try {
        this.assertNoMountWithin(join(move.fromParent.vfsAbsPath, move.fromName), move.from);
        if (sources.get(edgeKey(move.fromParent.id, move.fromName)) !== move) {
          throw new NodeInvalidOperationError(`'${move.from}' is moved twice in one call`);
        }
        if (move.to !== move.from && isPathWithin(move.to, move.from)) {
          throw new NodeInvalidOperationError(`cannot move '${move.from}' into itself`);
        }

        const dest = edgeKey(move.toParent.id, move.toName);
        const vacated = sources.get(dest);
        if (vacated && vacated !== move) {
          throw new NodeInvalidOperationError(`cannot move '${move.from}' to '${move.to}', which is moved in the same call`);
        }
        if (claimed.has(dest)) {
          throw new NodeAlreadyExistsError(move.toParent.id, move.toName);
        }
        for (let at = dirname(move.to); at.length > 1; at = dirname(at)) {
          const other = sourcePaths.get(at);
          if (other && other !== move) {
            throw new NodeInvalidOperationError(`cannot move '${move.from}' into '${at}', which is moved in the same call`);
          }
        }

        claimed.add(dest);
        kept.push(move);
      } catch (reason) {
        reject(move, reason);
      }
    }

    return kept;
  }

  /**
   * What a chunk's transaction needs to know before it begins: the node at each source and the
   * one each destination name holds, and the links to re-point, which with the parents make the
   * lock set. A source that is gone while its destination is there was moved by an earlier call
   * (`already`); one gone otherwise is refused.
   */
  private async readMoves<T extends NodeAttrs>(
    moves: PlannedMove[],
    opts: RenameManyOptions,
    results: PromiseSettledResult<RenamedNode<T>>[],
  ): Promise<MovePlan> {
    const edges = await this.namedEdges(moves.flatMap((move) => [
      { parentId: move.fromParent.id, name: move.fromName },
      { parentId: move.toParent.id, name: move.toName },
    ]));

    const read: ReadMove[] = [];
    const already: { move: PlannedMove; id: NodeId }[] = [];
    for (const move of moves) {
      const childId = edges.get(edgeKey(move.fromParent.id, move.fromName));
      const takenId = edges.get(edgeKey(move.toParent.id, move.toName));
      if (childId !== undefined) read.push({ ...move, childId, takenId });
      else if (takenId !== undefined) already.push({ move, id: takenId });
      else results[move.index] = { status: 'rejected', reason: new NodeNotFoundError(move.from) };
    }

    if (already.length > 0) {
      const nodes = await this.readNodes<T>(already.map((entry) => entry.id));
      for (const { move, id } of already) {
        const node = nodes.get(id);
        results[move.index] = node ? { status: 'fulfilled', value: { node, relinked: 0, already: true } } : { status: 'rejected', reason: new NodeNotFoundError(move.from) };
      }
    }

    const links = opts.relink !== false && read.length > 0 && this.store.findSoftlinksUnder
      ? await this.store.findSoftlinksUnder(read.map((move) => move.from), RELINK_LIMIT + 1)
      : [];
    if (links.length > RELINK_LIMIT) {
      const reason = new NodeInvalidOperationError(`more than ${RELINK_LIMIT} links point into the moved paths; move fewer at a time`);
      for (const move of read) results[move.index] = { status: 'rejected', reason };
      return { moves: [], nodeIds: [], linkIds: new Set() };
    }

    const nodeIds = new Set<NodeId>();
    for (const move of read) {
      nodeIds.add(move.fromParent.id).add(move.toParent.id).add(move.childId);
      if (move.takenId !== undefined) nodeIds.add(move.takenId);
    }

    return { moves: read, nodeIds: [...nodeIds], linkIds: new Set(links.map((link) => link.id)) };
  }

  /** The child id of each `(parent, name)` edge there is, keyed by `edgeKey`; in one read where the store can. */
  private async namedEdges(edges: ParentLink[], tx?: Transaction): Promise<Map<string, NodeId>> {
    const found = new Map<string, NodeId>();
    if (this.store.findChildLinks) {
      for (const edge of await this.store.findChildLinks(edges, tx)) found.set(edgeKey(edge.parentId, edge.name), edge.id);
      return found;
    }
    for (const { parentId, name } of edges) {
      const [link] = await this.store.getChildLinks(parentId, { name }, tx);
      if (link) found.set(edgeKey(parentId, name), link.id);
    }
    return found;
  }

  /**
   * A chunk's moves, under its locks and in its transaction. Every check comes before the first
   * write — `rename`'s on each move, then the names to be replaced, then the links to re-point — so
   * a refusal leaves nothing half done even in a store without transactions. A move that fails a
   * check is put in `refused` and left out; a link that fails one throws, failing the chunk.
   *
   * @returns the moves made, by index.
   */
  private async moveBatch<T extends NodeAttrs>(
    access: Access,
    mut: Mutation,
    plan: MovePlan,
    opts: RenameManyOptions,
    refused: Map<number, unknown>,
  ): Promise<Map<number, RenamedNode<T>>> {
    const done = new Map<number, RenamedNode<T>>();
    const nodes = await this.readNodes<T>(plan.nodeIds, mut.tx);
    const edges = await this.namedEdges(
      plan.moves.flatMap((move) => [
        { parentId: move.fromParent.id, name: move.fromName },
        { parentId: move.toParent.id, name: move.toName },
      ]),
      mut.tx,
    );

    let accepted: AcceptedMove<T>[] = [];
    for (const move of plan.moves) {
      try {
        const oldParent = nodes.get(move.fromParent.id);
        if (!oldParent) throw new NodeNotFoundError(dirname(move.from));
        assertAccess(access, oldParent, 'w');
        assertAccess(access, oldParent, 'x');

        // Another node there now is one the locks do not cover.
        const childId = edges.get(edgeKey(move.fromParent.id, move.fromName));
        const node = childId === move.childId ? nodes.get(childId) : undefined;
        if (!node) throw new NodeNotFoundError(move.from);
        assertAccess(access, node, 'w');

        const newParent = nodes.get(move.toParent.id);
        if (!newParent) throw new NodeNotFoundError(dirname(move.to));
        assertAccess(access, newParent, 'w');
        assertAccess(access, newParent, 'x');

        const destId = edges.get(edgeKey(move.toParent.id, move.toName));
        if (destId !== undefined) {
          if (opts.failIfExists) throw new NodeAlreadyExistsError(move.toParent.id, move.toName);
          // Both names already lead to the node, its own or a hard link: nothing changes.
          if (destId === move.childId) {
            done.set(move.index, { node, relinked: 0 });
            continue;
          }
          if (destId !== move.takenId) throw new NodeAlreadyExistsError(move.toParent.id, move.toName);
        }

        accepted.push({ ...move, node, oldParent, newParent, replaces: destId });
      } catch (reason) {
        refused.set(move.index, reason);
      }
    }

    // A taken name is given up by a node without children that the caller may write and no mount
    // stands on, as `rename` replaces one.
    const replacing = accepted.filter((move) => move.replaces !== undefined);
    if (replacing.length > 0) {
      const children = await this.childLinksIn(replacing.map((move) => move.replaces!), mut.tx);
      for (const move of replacing) {
        try {
          if ((children.get(move.replaces!)?.length ?? 0) > 0) throw new NodeInvalidOperationError(`cannot replace '${move.to}': it has children`);
          const dest = nodes.get(move.replaces!);
          if (!dest) throw new NodeAlreadyExistsError(move.toParent.id, move.toName);
          assertAccess(access, dest, 'w');
          if (this.mountpoints.some((mount) => mount.point.id === move.replaces)) throw new NodeBusyError(move.to);
        } catch (reason) {
          refused.set(move.index, reason);
        }
      }
      accepted = accepted.filter((move) => !refused.has(move.index));
    }

    const relinks = opts.relink !== false && accepted.length > 0 ? await this.relinksFor(access, mut, accepted, plan.linkIds) : [];

    for (const move of accepted) {
      this.declareWrite(mut, move.node.type);
      // A path-addressed store replaces the node there itself when it moves the edge.
      if (move.replaces !== undefined && !this.store.pathAddressed) {
        await this.detachEdge(access, mut, move.toParent, move.replaces, join(move.toParent.vfsAbsPath, move.toName));
      }
    }

    await this.moveEdges(
      access.uid,
      accepted.map((move) => ({
        from: { parentId: move.fromParent.id, name: move.fromName },
        to: { parentId: move.toParent.id, name: move.toName },
      })),
      mut.tx,
    );

    // A path-addressed store gives a node a new id at its new path.
    let moved = new Map(accepted.map((move) => [move.index, move.node]));
    if (this.store.pathAddressed && accepted.length > 0) {
      const after = await this.namedEdges(accepted.map((move) => ({ parentId: move.toParent.id, name: move.toName })), mut.tx);
      const ids = new Map(accepted.map((move) => [move.index, after.get(edgeKey(move.toParent.id, move.toName)) ?? move.childId]));
      const read = await this.readNodes<T>([...ids.values()], mut.tx);
      moved = new Map(accepted.map((move) => [move.index, read.get(ids.get(move.index)!) ?? move.node]));
    }

    const relinked = new Map<number, number>();
    if (relinks.length > 0) {
      const written = await this.writeEach(mut, access.uid, relinks.map((relink) => relink.change), (_id, error) => {
        throw error;
      });
      const paths = await this.store.resolvePaths?.(relinks.map((relink) => relink.link.id), mut.tx) ?? new Map<NodeId, StoredPath[]>();
      for (const { link, move, change } of relinks) {
        const node = written.get(link.id);
        // A link that was itself the node a move replaced is gone.
        if (!node) continue;
        relinked.set(move.index, (relinked.get(move.index) ?? 0) + 1);
        const path = paths.get(link.id)?.[0]?.path;
        if (path === undefined) continue;
        const entry: NodeEntry = { id: link.id, vfs: this, vfsAbsPath: path, absPath: path };
        this.updated(access, mut, entry, { ...link, props: { ...link.props, count: node.props.count } }, node, change.attrs);
      }
    }

    for (const move of accepted) {
      const node = moved.get(move.index)!;
      const oldPath = join(move.fromParent.vfsAbsPath, move.fromName);
      const newPath = join(move.toParent.vfsAbsPath, move.toName);

      mut.emit('child-detached', move.fromParent.vfsAbsPath, move.oldParent, undefined, access.uid);
      mut.emit('moved', newPath, node, node, access.uid, oldPath);
      mut.audit(access, { op: 'move', node, path: newPath, fromPath: oldPath });
      if (move.oldParent.id !== move.newParent.id) {
        mut.emit('child-attached', move.toParent.vfsAbsPath, move.newParent, undefined, access.uid);
      }

      done.set(move.index, { node, relinked: relinked.get(move.index) ?? 0 });
    }

    return done;
  }

  /**
   * The links a chunk's moves re-point, read again under its transaction: each must be one the
   * lock set holds, or the set is stale, and one the caller may write, or the chunk fails. The
   * softlink takes the longest moved source it starts with; a relation link's `peerLink` follows
   * the same moves.
   */
  private async relinksFor<T extends NodeAttrs>(access: Access, mut: Mutation, moves: AcceptedMove<T>[], locked: Set<NodeId>): Promise<Relink[]> {
    if (!this.store.findSoftlinksUnder) return [];

    const where = movedPath(moves);
    const relinks: Relink[] = [];
    for (const link of await this.store.findSoftlinksUnder(moves.map((move) => move.from), RELINK_LIMIT + 1, mut.tx)) {
      if (!locked.has(link.id)) throw new LinksChangedError();
      const target = where(link.props.softlink!);
      if (!target) continue;
      assertAccess(access, link, 'w');

      const relation = (link.attrs as RelationAttrs).relation;
      const peer = relation?.peerLink ? where(relation.peerLink) : undefined;
      relinks.push({
        link,
        move: target.move,
        change: { id: link.id, props: { softlink: target.path }, ...(relation && peer ? { attrs: { relation: { ...relation, peerLink: peer.path } } } : {}) },
      });
    }
    return relinks;
  }

  /**
   * After every chunk, the links still at a path a move left: those another store holds, which no
   * chunk's transaction reaches, and those to a node moved between stores. Found as the caller
   * sees them and re-pointed with `updateEach`, each counted to its move. A move whose source a
   * later move filled again, or whose tree one filled, is left out: a link there now means the
   * newcomer.
   */
  private async relinkElsewhere<T extends NodeAttrs>(access: Access, made: PlannedMove[], results: PromiseSettledResult<RenamedNode<T>>[]): Promise<void> {
    const destinations = new Set<NodePath>();
    const aboveDestinations = new Set<NodePath>();
    for (const move of made) {
      destinations.add(move.to);
      for (let at = dirname(move.to); at.length > 1; at = dirname(at)) aboveDestinations.add(at);
    }
    const refilled = (path: NodePath): boolean => {
      if (aboveDestinations.has(path)) return true;
      for (let at = path; at.length > 1; at = dirname(at)) {
        if (destinations.has(at)) return true;
      }
      return false;
    };
    const left = made.filter((move) => !refilled(move.from));
    if (left.length === 0) return;

    const where = movedPath(left);
    const changes: NodeChange[] = [];
    const follows: PlannedMove[] = [];
    for (const link of await this.findLinksUnder(access, left.map((move) => move.from), RELINK_LIMIT)) {
      const target = where(link.target);
      if (!target) continue;
      const relation = (link.node.attrs as RelationAttrs).relation;
      const peer = relation?.peerLink ? where(relation.peerLink) : undefined;
      changes.push({
        ref: link.absPath,
        readlink: true,
        props: { softlink: target.path },
        ...(relation && peer ? { attrs: { relation: { ...relation, peerLink: peer.path } } } : {}),
      });
      follows.push(target.move);
    }
    if (changes.length === 0) return;

    const settled = await this.updateEach(access, changes);
    settled.forEach((outcome, i) => {
      const result = results[follows[i].index];
      if (outcome.status === 'fulfilled' && result?.status === 'fulfilled') result.value.relinked++;
      else if (outcome.status === 'rejected') logger.warn('a link to a moved path was not re-pointed', { path: changes[i].ref, error: outcome.reason });
    });
  }

  /** Move many edges in one statement where the store can, otherwise one at a time in the same transaction. */
  private async moveEdges(uid: UserId, moves: EdgeMove[], tx: Transaction): Promise<void> {
    if (moves.length === 0) return;
    if (this.store.moveChildren) {
      await this.store.moveChildren(uid, moves, tx);
      return;
    }
    for (const { from, to } of moves) await this.store.moveChild!(uid, from.parentId, from.name, to.parentId, to.name, tx);
  }

  /** Child edges for many nodes inside a transaction, batched when the store can do it. */
  private async childLinksIn(ids: NodeId[], tx: Transaction): Promise<Map<NodeId, NodeChild[]>> {
    if (this.store.getChildLinksMany) return await this.store.getChildLinksMany(ids, tx);
    const links = new Map<NodeId, NodeChild[]>();
    for (const id of ids) links.set(id, await this.store.getChildLinks(id, undefined, tx));
    return links;
  }

  async link<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions,
  ): Promise<Node<T>> {
    const entry = await this.resolveEntry(access, ref, opts);
    const parentEntry = await this.resolveEntry(access, parentRef, { follow: opts?.follow });

    this.assertMountWritable(parentEntry);

    if (entry.vfs === this && parentEntry.vfs === this) {
      if (!this.store.linkChild) {
        throw new NodeInvalidOperationError('link is not supported on this system backend');
      }

      // Lock both the parent and the node being linked
      return this.withTransaction([parentEntry.id, entry.id], async (mut) => {
        return this.doLinkInternal<T>(access, mut, entry, parentEntry, name);
      });
    }

    if (entry.vfs !== parentEntry.vfs) {
      throw new NodeInvalidOperationError('cannot link across different VFS backends');
    }

    return await entry.vfs.link<T>(access, entry, parentEntry, name, opts);
  }

  /** Internal link implementation - assumes locks are already held. */
  private async doLinkInternal<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    mut: Mutation,
    entry: NodeEntry,
    parentEntry: NodeEntry,
    name: string,
  ): Promise<Node<T>> {
    if (!this.store.linkChild) {
      throw new NodeInvalidOperationError('link is not supported on this system backend');
    }

    const parent = await this.store.getNode(parentEntry.id, mut.tx);
    assertAccess(access, parent, 'w');
    assertAccess(access, parent, 'x');

    // Reject duplicate names — except when a dynamic store (filesystem)
    // already reflects the node itself under this name, which is the one case
    // `linkChild` is allowed to treat as a no-op.
    const [existing] = await this.store.getChildLinks(parent.id, { name }, mut.tx);
    if (existing && existing.id !== entry.id) {
      throw new NodeAlreadyExistsError(parent.id, name);
    }

    const node = await this.store.getNode<T>(entry.id, mut.tx);
    assertIdentityCreatable(access, join(parentEntry.vfsAbsPath, name), node.type, 'link');

    // One new edge, whatever the directory's size
    await this.store.linkChild(access.uid, parent.id, entry.id, name, mut.tx);

    // The store raised the link count as part of that edge, so the node we
    // already hold plus one is what a re-read would have said.
    const linkedNode: Node<T> = { ...node, props: { ...node.props, count: node.props.count + 1 } };

    // The parent, as on `create` and `mv`: a hard link is the one attachment with
    // no `created` event, so a consumer bound to the container's type is the only
    // one that can see it — which is what makes carrying the parent the useful half.
    mut.emit('child-attached', parentEntry.vfsAbsPath, parent, undefined, access.uid);
    mut.audit(access, { op: 'link', node: linkedNode, path: join(parentEntry.vfsAbsPath, name) });

    return linkedNode;
  }

  async unlink(
    access: Access,
    ref: NodeReference,
    parentRef: NodeReference,
    opts?: NodeResolveOptions & {
      recursive?: boolean;
    },
  ): Promise<boolean> {
    const entry = await this.resolveEntry(access, ref, opts);
    const parentEntry = await this.resolveEntry(access, parentRef, { follow: opts?.follow });

    this.assertMountWritable(parentEntry);

    if (entry.vfs === this && parentEntry.vfs === this) {
      if (!this.store.unlinkChild) {
        throw new NodeInvalidOperationError('unlink is not supported on this system backend');
      }

      // Before anything goes: a recursive unlink would otherwise empty the rest of the tree first.
      // The walk below still refuses a mount point it meets by id.
      this.assertNoMountWithin(entry.vfsAbsPath, entry.absPath || entry.vfsAbsPath);

      // Empty the subtree before touching the edge that holds it, so the tree
      // stays reachable while it drains: an abort part-way leaves a smaller but
      // consistent tree that re-running the same unlink finishes. Only when
      // this is the node's last link — a node still linked elsewhere keeps its
      // children, we are just dropping one edge.
      //
      // Children can arrive between the subtree emptying and the edge going — a pipeline reacting
      // to the members just removed — so it is emptied again, a few times before giving up.
      const detach = () =>
        this.withTransaction(
          [parentEntry.id, entry.id],
          (mut) => this.detachEdge(access, mut, parentEntry, entry.id, entry.vfsAbsPath),
        );
      if (!opts?.recursive || (await this.store.getNode(entry.id)).props.count > 1) return await detach();
      for (let pass = 1;; pass++) {
        await this.reapSubtrees(access, [entry]);
        try {
          return await detach();
        } catch (error) {
          if (!(error instanceof NodeNotEmptyError) || pass >= REFILLED_PASSES) throw error;
        }
      }
    }

    if (entry.vfs !== parentEntry.vfs) {
      throw new NodeInvalidOperationError('cannot unlink across different VFS backends');
    }

    return await entry.vfs.unlink(access, entry, parentEntry, opts);
  }

  async unlinkMany(access: Access, targets: UnlinkTarget[], opts: { signal?: AbortSignal; recursive?: boolean } = {}): Promise<PromiseSettledResult<boolean>[]> {
    const results: PromiseSettledResult<boolean>[] = new Array(targets.length);

    for (let start = 0; start < targets.length; start += WRITE_BATCH) {
      if (opts.signal?.aborted) {
        results.fill({ status: 'rejected', reason: opts.signal.reason }, start);
        break;
      }

      // Each parent once a chunk.
      const parents = new Map<NodePath, Promise<NodeEntry>>();
      const planned = new Map<NodeVFS, PlannedUnlink[]>();
      for (const [i, target] of targets.slice(start, start + WRITE_BATCH).entries()) {
        const index = start + i;
        try {
          let parent: NodeEntry;
          let name: string;
          if (typeof target === 'string') {
            const path = this.normalizePath(target);
            if (path === '/') throw new NodeInvalidOperationError('cannot unlink the root');
            let entry = parents.get(dirname(path));
            if (!entry) {
              entry = this.resolveEntry(access, dirname(path));
              parents.set(dirname(path), entry);
            }
            parent = await entry;
            name = basename(path);
          } else {
            ({ parent, name } = target);
          }
          this.assertMountWritable(parent);
          planned.set(parent.vfs, [...planned.get(parent.vfs) ?? [], { index, parent, name, path: join(parent.absPath || parent.vfsAbsPath, name) }]);
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }

      for (const [vfs, group] of planned) {
        if (vfs === this) {
          await this.unlinkChunk(access, group, results, opts.recursive);
          continue;
        }
        const settled = await vfs.unlinkMany(access, group.map(({ parent, name }) => ({ parent, name })), { recursive: opts.recursive });
        group.forEach((item, i) => {
          results[item.index] = settled[i];
        });
      }
    }

    return results;
  }

  /**
   * One chunk of `unlinkMany` within this VFS's own store: the edges read, then removed in one
   * transaction under the lock set of their parents and children. With `recursive`, the subtrees of
   * the nodes losing their last link are emptied first, together.
   */
  private async unlinkChunk(access: Access, items: PlannedUnlink[], results: PromiseSettledResult<boolean>[], recursive = false): Promise<void> {
    if (!this.store.unlinkChild && !this.store.unlinkChildren) {
      const reason = new NodeInvalidOperationError('unlink is not supported on this system backend');
      for (const item of items) results[item.index] = { status: 'rejected', reason };
      return;
    }

    const edges = await this.namedEdges(items.map((item) => ({ parentId: item.parent.id, name: item.name })));
    const named = new Set<string>();
    let live: (PlannedUnlink & { childId: NodeId })[] = [];
    for (const item of items) {
      const key = edgeKey(item.parent.id, item.name);
      const childId = edges.get(key);
      try {
        this.assertNoMountWithin(join(item.parent.vfsAbsPath, item.name), item.path);
        if (childId === undefined || named.has(key)) throw new NodeNotFoundError(item.path);
        named.add(key);
        live.push({ ...item, childId });
      } catch (reason) {
        results[item.index] = { status: 'rejected', reason };
      }
    }
    // A node that gained children after its subtree was emptied is emptied again, as `unlink` does.
    for (let pass = 1;; pass++) {
      if (recursive) live = await this.reapChunk(access, live, results);
      if (live.length === 0) return;

      // Refusals are known before anything is written, so they stand whatever becomes of the rest.
      const refused = new Map<number, unknown>();
      try {
        const lockIds = live.flatMap((item) => [item.parent.id, item.childId]);
        const deleted = await this.withTransaction(lockIds, (mut) => this.unlinkBatch(access, mut, live, refused));
        for (const item of live) {
          results[item.index] = refused.has(item.index) ? { status: 'rejected', reason: refused.get(item.index) } : { status: 'fulfilled', value: deleted.has(item.index) };
        }
      } catch (error) {
        // Rolled back: nothing in the chunk was written.
        for (const item of live) results[item.index] = { status: 'rejected', reason: refused.get(item.index) ?? error };
        return;
      }
      if (!recursive || pass >= REFILLED_PASSES) return;
      live = live.filter((item) => refused.get(item.index) instanceof NodeNotEmptyError);
    }
  }

  /**
   * Empty the subtrees of a recursive chunk's nodes that lose their last link in it, as `unlink`
   * empties one, all in one walk. Should that fail, each subtree is emptied alone, so a failure is
   * its own target's.
   *
   * @returns the items whose subtrees are empty, or which keep theirs.
   */
  private async reapChunk(
    access: Access,
    items: (PlannedUnlink & { childId: NodeId })[],
    results: PromiseSettledResult<boolean>[],
  ): Promise<(PlannedUnlink & { childId: NodeId })[]> {
    const nodes = await this.readNodes(items.map((item) => item.childId));
    const taken = new Map<NodeId, number>();
    for (const item of items) taken.set(item.childId, (taken.get(item.childId) ?? 0) + 1);
    const roots = new Map<NodeId, NodeEntry>();
    for (const item of items) {
      const count = nodes.get(item.childId)?.props.count ?? 0;
      if (count > (taken.get(item.childId) ?? 0) || roots.has(item.childId)) continue;
      roots.set(item.childId, { id: item.childId, vfs: this, vfsAbsPath: join(item.parent.vfsAbsPath, item.name), absPath: item.path });
    }
    if (roots.size === 0) return items;

    try {
      await this.reapSubtrees(access, [...roots.values()]);
      return items;
    } catch {
      const failed = new Map<NodeId, unknown>();
      for (const root of roots.values()) {
        try {
          await this.reapSubtrees(access, [root]);
        } catch (reason) {
          failed.set(root.id, reason);
        }
      }
      return items.filter((item) => {
        const reason = failed.get(item.childId);
        if (reason !== undefined) results[item.index] = { status: 'rejected', reason };
        return reason === undefined;
      });
    }
  }

  /**
   * A chunk's unlinks, under its locks and in its transaction, as `detachEdge` makes one: each
   * check on every edge first — the parent writable and enterable, the edge still the one read, a
   * node losing its last link childless and no mount point — then one write of the edges and one
   * of the nodes left with none.
   *
   * @returns the indexes of the unlinks that deleted their node.
   */
  private async unlinkBatch(
    access: Access,
    mut: Mutation,
    items: (PlannedUnlink & { childId: NodeId })[],
    refused: Map<number, unknown>,
  ): Promise<Set<number>> {
    const childIds = [...new Set(items.map((item) => item.childId))];
    const nodes = await this.readNodes([...items.map((item) => item.parent.id), ...childIds], mut.tx);
    const edges = await this.namedEdges(items.map((item) => ({ parentId: item.parent.id, name: item.name })), mut.tx);
    const linkCounts = await this.linkCountsIn(childIds, mut.tx);

    const accepted: (PlannedUnlink & { childId: NodeId; parentNode: Node; node: Node })[] = [];
    for (const item of items) {
      try {
        const parentNode = nodes.get(item.parent.id);
        if (!parentNode) throw new NodeNotFoundError(dirname(item.path));
        assertAccess(access, parentNode, 'w');
        assertAccess(access, parentNode, 'x');
        const node = edges.get(edgeKey(item.parent.id, item.name)) === item.childId ? nodes.get(item.childId) : undefined;
        if (!node) throw new NodeNotFoundError(item.path);
        accepted.push({ ...item, parentNode, node });
      } catch (reason) {
        refused.set(item.index, reason);
      }
    }

    // A node goes once the batch takes its last edge, however many of them the batch takes.
    const taken = new Map<NodeId, number>();
    for (const item of accepted) taken.set(item.childId, (taken.get(item.childId) ?? 0) + 1);
    const going = [...taken].filter(([id, count]) => (linkCounts.get(id) ?? 0) <= count).map(([id]) => id);
    const children = going.length > 0 ? await this.childLinksIn(going, mut.tx) : new Map<NodeId, NodeChild[]>();
    const refusedNodes = new Map<NodeId, unknown>();
    for (const item of accepted) {
      if (!going.includes(item.childId)) continue;
      if ((children.get(item.childId)?.length ?? 0) > 0) {
        refusedNodes.set(item.childId, new NodeNotEmptyError(item.path));
      } else if (this.mountpoints.some((mount) => mount.point.id === item.childId)) {
        refusedNodes.set(item.childId, new NodeBusyError(item.path));
      }
    }
    const kept = accepted.filter((item) => {
      const reason = refusedNodes.get(item.childId);
      if (reason) refused.set(item.index, reason);
      return !reason;
    });
    if (kept.length === 0) return new Set();

    for (const item of kept) this.declareWrite(mut, item.node.type);
    const removed = kept.map((item) => ({ parentId: item.parent.id, name: item.name, id: item.childId }));
    if (this.store.unlinkChildren) {
      await this.store.unlinkChildren(access.uid, removed, mut.tx);
    } else {
      for (const edge of removed) await this.store.unlinkChild!(access.uid, edge.parentId, edge.id, edge.name, mut.tx);
    }

    const deleted = new Set(going.filter((id) => !refusedNodes.has(id)));
    if (deleted.size > 0) {
      if (this.store.deleteNodes) await this.store.deleteNodes(access.uid, [...deleted], mut.tx);
      else if (this.store.deleteNode) {
        for (const id of deleted) await this.store.deleteNode(access.uid, id, mut.tx);
      }
    }

    // A deleted node is announced once, under the last of its names to go; the others were unlinks.
    const lastName = new Map(kept.map((item) => [item.childId, item.index]));
    const deletedAt = new Set<number>();
    const storage: { reg: NonNullable<VfsRegistries[keyof VfsRegistries]>; id: string; node: Node }[] = [];
    for (const item of kept) {
      const path = join(item.parent.vfsAbsPath, item.name);
      mut.emit('child-detached', item.parent.vfsAbsPath, item.parentNode, undefined, access.uid);

      if (!deleted.has(item.childId) || lastName.get(item.childId) !== item.index) {
        mut.audit(access, { op: 'unlink', node: item.node, path });
        continue;
      }
      deletedAt.add(item.index);

      const reg = this.regs[item.node.type as keyof VfsRegistries];
      if (reg) storage.push({ reg, id: this.store.pathAddressed ? path : item.childId, node: item.node });
      mut.emit('deleted', path, item.node, undefined, access.uid);
      mut.audit(access, { op: 'delete', node: item.node, path });
    }

    // Storage goes once the delete is committed: a rolled-back delete keeps its bytes.
    if (storage.length > 0) {
      mut.afterCommit(async () => {
        let next = 0;
        const worker = async () => {
          while (next < storage.length) {
            const { reg, id, node } = storage[next++];
            try {
              await reg.delete(id, this.tierOpts(node) as any);
            } catch (error) {
              if (!(error instanceof NodeNotSupportedError)) logger.error('resource delete failed', { error, nodeId: node.id });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(STORAGE_DELETES, storage.length) }, worker));
      });
    }

    return deletedAt;
  }

  /** How many edges point at each node, read inside a transaction; batched when the store can. */
  private async linkCountsIn(ids: NodeId[], tx: Transaction): Promise<Map<NodeId, number>> {
    const counts = new Map<NodeId, number>();
    if (this.store.getParentLinksMany) {
      for (const [id, links] of await this.store.getParentLinksMany(ids, tx)) counts.set(id, links.length);
      return counts;
    }
    for (const id of ids) {
      try {
        counts.set(id, (await this.store.getNode(id, tx)).props.count);
      } catch (error) {
        if (!(error instanceof NodeNotFoundError)) throw error;
      }
    }
    return counts;
  }

  /**
   * Remove one hierarchy edge, deleting the node itself when its last link
   * goes. Must be called with locks held on both ids.
   *
   * The edge is the one from the parent to `nodeId` named by `nodePath`'s last
   * segment, so a node linked twice under one parent loses only that name. Without
   * a path, or when no edge carries its name, the parent's first edge to the node
   * goes.
   */
  private async detachEdge(
    access: Access,
    mut: Mutation,
    parentEntry: NodeEntry,
    nodeId: NodeId,
    nodePath?: NodePath,
  ): Promise<boolean> {
    const parent = await this.store.getNode(parentEntry.id, mut.tx);
    assertAccess(access, parent, 'w');
    assertAccess(access, parent, 'x');

    const node = await this.store.getNode(nodeId, mut.tx);
    this.declareWrite(mut, node.type);

    const links = await this.store.getChildLinks(parent.id, { childId: nodeId }, mut.tx);
    const childInfo = links.find((link) => nodePath && link.name === basename(nodePath)) ?? links[0];
    if (!childInfo) {
      throw new NodeNotFoundError(nodePath || join(parentEntry.vfsAbsPath, nodeId));
    }

    const path = nodePath || join(parentEntry.vfsAbsPath, childInfo.name);

    const newCount = node.props.count - 1;

    // A final unlink of a node that still has children would orphan them. With
    // `recursive` the subtree was already drained, so children here arrived
    // since, and `unlink` empties it again.
    if (newCount <= 0 && (await this.store.getChildLinks(nodeId, undefined, mut.tx)).length > 0) {
      throw new NodeNotEmptyError(path);
    }

    // The node a mount stands on stays, as Unix answers `EBUSY`: the mount would remain listed with
    // no node left to unmount it by.
    if (newCount <= 0 && this.mountpoints.some((m) => m.point.id === nodeId)) {
      throw new NodeBusyError(path);
    }

    // Detach from the parent — one edge, not a rewrite of the directory
    await this.store.unlinkChild!(access.uid, parent.id, nodeId, childInfo.name, mut.tx);

    // Emit child-detached from parent first (pass parent node for type info)
    mut.emit('child-detached', parentEntry.vfsAbsPath, parent, undefined, access.uid);

    // Storage remains while another name still points at the node — it is
    // addressed by id, not by the path that just went. The store lowered the
    // link count with the edge.
    if (newCount > 0) {
      mut.audit(access, { op: 'unlink', node, path });
      return true;
    }

    if (this.store.deleteNode) {
      await this.store.deleteNode(access.uid, nodeId, mut.tx);
    }

    // Delete physical storage (only when fully deleted, not just unlinked), once
    // the delete is committed: a rolled-back delete keeps its bytes.
    const reg = this.regs[node.type as keyof VfsRegistries];
    if (reg) {
      // A path-addressed store's registry takes the path within the mount
      const id = this.store.pathAddressed ? path : nodeId;

      mut.afterCommit(async () => {
        try {
          await reg.delete(id, this.tierOpts(node) as any);
        } catch (error) {
          // Best effort
          if (!(error instanceof NodeNotSupportedError)) {
            logger.error('resource delete failed', { error, nodeId: node.id });
          }
        }
      });
    }

    mut.emit('deleted', path, node, undefined, access.uid);
    mut.audit(access, { op: 'delete', node, path });

    return true;
  }

  /**
   * Empty nodes of their descendants, deepest level first, in batches: the subtrees of all `roots`
   * are walked and removed together, so many small trees cost no more than one of their size.
   *
   * The subtrees are read a level at a time, `LIST_BATCH` directories per store read, then removed
   * from the bottom up, `WRITE_BATCH` edges per transaction as `unlinkMany` removes them. A node's
   * children lie a level below its deepest edge, so every directory losing its last link in a batch
   * is already empty.
   *
   * Deliberately **not** one transaction. A batch takes its whole lock set at
   * once, commits, and releases, holding nothing in between. One transaction
   * descending lock by lock would hold row locks for what it already deleted
   * while another writer takes a mutex it released, and Postgres cannot see a
   * JS mutex to break the resulting cycle. Batches make the cycle impossible
   * and keep row locks short enough that no one queues behind them.
   *
   * The cost is atomicity: a concurrent reader can see a half-emptied
   * directory, and a failure leaves the tree partly deleted. It stays reachable
   * throughout, so re-running the unlink finishes the job — which is what
   * `rm -r` does on a real filesystem anyway.
   *
   * The walk goes by **id**, so a softlink child is removed, never followed to
   * its target.
   */
  private async reapSubtrees(access: Access, roots: NodeEntry[]): Promise<void> {
    const childEntry = (parent: NodeEntry, name: string, id: NodeId): NodeEntry => ({
      id,
      vfs: this,
      vfsAbsPath: join(parent.vfsAbsPath, name),
      absPath: join(parent.absPath || parent.vfsAbsPath, name),
    });

    let stalled = 0;
    let removed: number | undefined;
    let moved = false;
    for (;;) {
      const levels: (PlannedUnlink & { childId: NodeId })[][] = [];
      const links = new Map<NodeId, number>();
      let frontier = roots;
      while (frontier.length > 0) {
        const level: (PlannedUnlink & { childId: NodeId })[] = [];
        const next: NodeEntry[] = [];
        for (let start = 0; start < frontier.length; start += LIST_BATCH) {
          const parents = frontier.slice(start, start + LIST_BATCH);
          const listings = await this.childrenOf(parents.map((parent) => parent.id), new Map());
          for (const parent of parents) {
            for (const child of listings.get(parent.id) ?? []) {
              const entry = childEntry(parent, child.name, child.node.id);
              level.push({ index: level.length, parent, name: child.name, path: entry.absPath!, childId: child.node.id });
              // A node is descended into once the walk has met every link it has, so all of them
              // go; one still linked from outside keeps its subtree, and only these edges go. A
              // link made while the tree drains is not defended against: only `ln` into a tree
              // mid-delete can make one.
              const met = (links.get(child.node.id) ?? 0) + 1;
              links.set(child.node.id, met);
              if (met === Math.max(child.node.props.count, 1)) next.push(entry);
            }
          }
        }
        if (level.length > 0) levels.push(level);
        frontier = next;
      }

      if (levels.length === 0) return;

      // A pass that removed nothing found the tree changed under every edge it read, or a node
      // that refuses to go. Moves inside the tree can make a pass's whole reading stale, so a few
      // such passes in a row are retried; past that, another identical pass would spin.
      if (removed !== undefined) {
        stalled = removed > 0 ? 0 : stalled + 1;
        if (removed === 0 && (!moved || stalled >= STALLED_PASSES)) {
          throw new NodeInvalidOperationError(`cannot remove '${levels[0][0].parent.vfsAbsPath}': subtree changed during delete`);
        }
      }

      removed = 0;
      moved = false;
      for (const level of levels.toReversed()) {
        for (let start = 0; start < level.length; start += WRITE_BATCH) {
          const items = level.slice(start, start + WRITE_BATCH).map((item, index) => ({ ...item, index }));
          const refused = new Map<number, unknown>();
          await this.withTransaction(
            items.flatMap((item) => [item.parent.id, item.childId]),
            (mut) => this.unlinkBatch(access, mut, items, refused),
          );
          // Gone or moved since it was read, or repopulated: the next pass re-walks whatever is left.
          for (const reason of refused.values()) {
            if (reason instanceof NodeNotFoundError) moved = true;
            else if (!(reason instanceof NodeInvalidOperationError)) throw reason;
          }
          removed += items.length - refused.size;
        }
      }
    }
  }

  async copy<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    sourceRef: NodeReference,
    destParentRef: NodeReference,
    newName?: string,
    opts?: NodeResolveOptions & CopyOptions,
  ): Promise<Node<T>> {
    const sourceEntry = await this.resolveEntry(access, sourceRef, opts);
    const destParentEntry = await this.resolveEntry(access, destParentRef, { follow: opts?.follow });

    this.assertMountWritable(destParentEntry);

    const sourceNode = await sourceEntry.vfs.get<T>(access, sourceEntry.vfsAbsPath, opts);
    const targetName = newName ?? this.getNodeName(sourceNode, sourceEntry);

    // The whole source is read and checked before anything is written, so a refusal there leaves
    // the destination untouched.
    const plan = await this.planCopy(access, sourceNode, sourceEntry.vfsAbsPath, sourceEntry.vfs, targetName, opts, 0);

    const destVfs = destParentEntry.vfs;
    const destPath = join(destParentEntry.vfsAbsPath, targetName);

    // What is replaced is the name in the destination, a softlink there included, never its target.
    if (await destVfs.exists(access, destPath, { follow: false })) {
      if (!opts?.overwrite) {
        throw new NodeAlreadyExistsError(destParentEntry.id, targetName);
      }

      await destVfs.unlink(access, destPath, destParentEntry.vfsAbsPath, { recursive: true, follow: false });
    }

    // Nothing hears of the copy until its tree is whole: a file announced before its `metadata/`
    // is written reads as new to whatever indexes files, which then writes its own children
    // under it, such as a photo's `thumbnails/`, where the copy is about to write the source's.
    if (heldDeliveries.getStore()) return await this.writeCopyTree<T>(access, plan, sourceEntry.vfs, destVfs, destParentEntry.vfsAbsPath, destPath);

    const held: (() => Promise<void>)[] = [];
    try {
      return await heldDeliveries.run(held, () => this.writeCopyTree<T>(access, plan, sourceEntry.vfs, destVfs, destParentEntry.vfsAbsPath, destPath));
    } finally {
      for (const deliver of held) await deliver();
    }
  }

  /** Write a planned copy at `destPath` with its modes, or remove what was written when a write fails. */
  private async writeCopyTree<T extends NodeAttrs>(
    access: Access,
    plan: CopyPlan,
    sourceVfs: NodeVFS,
    destVfs: NodeVFS,
    destParentPath: NodePath,
    destPath: NodePath,
  ): Promise<Node<T>> {
    const written: CopyWritten[] = [];
    try {
      await this.writeCopy(access, plan, sourceVfs, destVfs, destParentPath, written);

      // A copy keeps the source's mode less the write bits a create there would not give, the way
      // `cp` applies the umask: group write only where the destination's group could write the
      // parent, as in `modeUnder`, and never others' write. A module's `etc/` file checked out
      // 0664 lands in the 0755 /etc as 0644.
      const destParent = await destVfs.get(access, destParentPath);
      const dropped = 0o002 | (destParent.props.mode & 0o020 ? 0 : 0o020);

      // Modes and frozen state go on last, deepest first, once nothing more is written below them.
      for (const entry of [...written].reverse()) {
        const mode = entry.source.props.mode & ~dropped;
        const { frozen } = entry.source.attrs;
        if (mode !== entry.copy.props.mode || frozen) {
          entry.copy = await destVfs.update(access, entry.path, {
            follow: false,
            props: { mode },
            ...(frozen ? { attrs: { frozen } } : {}),
          });
        }
      }

      return written[0].copy as Node<T>;
    } catch (error) {
      // Only what this copy created is removed; a create refused at the top leaves nothing behind.
      if (written.length > 0) {
        await destVfs.unlink(access, destPath, destParentPath, { recursive: true, follow: false }).catch((cleanupError) => {
          logger.error('removing a failed copy failed', { error: cleanupError, path: destPath });
        });
      }
      throw error;
    }
  }

  /**
   * Get the name of a node from its entry or find it in parent's children
   */
  private getNodeName<T extends NodeAttrs>(node: Node<T>, entry: NodeEntry): string {
    // Try to extract name from path
    if (entry.vfsAbsPath && entry.vfsAbsPath !== '/') {
      const parts = entry.vfsAbsPath.split('/').filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
    }
    // Fallback to node id
    return node.id;
  }

  /**
   * Read the tree a copy will write: every node readable, every node with children listable and
   * copied only with `recursive`, no deeper than `maxDepth`.
   */
  private async planCopy(
    access: Access,
    node: Node,
    sourcePath: NodePath,
    sourceVfs: NodeVFS,
    name: string,
    opts: CopyOptions | undefined,
    depth: number,
  ): Promise<CopyPlan> {
    const maxDepth = opts?.maxDepth ?? 100;

    if (depth > maxDepth) {
      throw new NodeInvalidOperationError(`copy exceeded maximum depth of ${maxDepth}`);
    }

    assertAccess(access, node, 'r');

    // A softlink is copied as the link; what it names is not part of the tree.
    const children: CopyPlan[] = [];
    const count = node.props.softlink ? 0 : await sourceVfs.childCount(access, sourcePath, { all: true });
    if (count > 0) {
      if (!opts?.recursive) {
        throw new NodeInvalidOperationError(`cannot copy node '${name}' with children without recursive option`);
      }

      // A listing leaves out the children the caller may not read; copying the rest would leave a
      // copy that is missing them, so the copy is refused as an unreadable child refuses it.
      const listed = await sourceVfs.children(access, sourcePath);
      if (listed.length < count) throw new NodeAccessDeniedError(sourcePath, 'r');

      for (const child of listed) {
        children.push(await this.planCopy(access, child.node, join(sourcePath, child.name), sourceVfs, child.name, opts, depth + 1));
      }
    }

    return { node, sourcePath, name, children };
  }

  /**
   * Create one copied node under `destParentPath`, then its content and children, recording every
   * node created in `written`, parents before their children. Each is created writable by its
   * owner, and searchable when it gets children, so what goes below it can be written; `copy`
   * sets the source's mode and frozen state afterwards.
   */
  private async writeCopy(
    access: Access,
    plan: CopyPlan,
    sourceVfs: NodeVFS,
    destVfs: NodeVFS,
    destParentPath: NodePath,
    written: CopyWritten[],
  ): Promise<void> {
    const { frozen: _frozen, ...attrs } = plan.node.attrs;
    const path = join(destParentPath, plan.name);

    const copy = await destVfs.create(access, plan.node.type, destParentPath, plan.name, {
      // The group comes from the destination, as for any create.
      props: {
        mode: plan.node.props.mode | 0o200 | (plan.children.length > 0 ? 0o100 : 0),
        uid: access.uid,
        softlink: plan.node.props.softlink,
      },
      attrs,
    });
    written.push({ source: plan.node, copy, path });

    // Only byte-content node types carry content over; queue and log copy semantics are undefined
    if (CONTENT_COPY_TYPES.has(plan.node.type)) {
      await this.copyFileContent(access, plan.sourcePath, sourceVfs, path, destVfs);
    }

    for (const child of plan.children) {
      await this.writeCopy(access, child, sourceVfs, destVfs, path, written);
    }
  }

  /**
   * Copy file content from source to destination by streaming
   */
  private async copyFileContent(
    access: Access,
    sourcePath: NodePath,
    sourceVfs: NodeVFS,
    destPath: NodePath,
    destVfs: NodeVFS,
  ): Promise<void> {
    const sourceHandle = await sourceVfs.open(access, sourcePath, { mode: 'r' });
    const destHandle = await destVfs.open(access, destPath, { mode: 'w' });

    try {
      await sourceHandle.readable.pipeTo(destHandle.writable);
    } finally {
      await sourceHandle.close();
      await destHandle.close();
    }
  }

  async open(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      mode?: ResourceMode;
      tx?: Transaction;
    },
  ): Promise<ResourceHandleIf> {
    const entry = await this.resolveEntry(access, ref, opts);
    const mode = opts?.mode || 'r';

    // Reject writes into a read-only mount before delegating to its backend
    if (mode.includes('w') || mode.includes('a') || mode.includes('+')) {
      this.assertMountWritable(entry);
    }

    if (entry.vfs === this) {
      // Check access to the file based on the open mode
      const node = await this.store.getNode(entry.id, opts?.tx);

      // Check read access for read modes
      if (mode.includes('r')) {
        assertAccess(access, node, 'r');
      }

      // Check write access for write/append modes
      if (mode.includes('w') || mode.includes('a') || mode.includes('+')) {
        assertAccess(access, node, 'w');

        if (node.attrs.frozen) {
          throw new NodeFrozenError(node.id);
        }
      }

      const reg = this.regs[node.type as keyof VfsRegistries];

      if (!reg) {
        throw new NodeNotSupportedError(node.type);
      }

      // A path-addressed store's registry takes the path within the mount
      const id = this.store.pathAddressed ? entry.vfsAbsPath : entry.id;

      const handle = await reg.open(id, this.tierOpts(node) as any, mode);

      // Track size on writable file handles: persist attrs.size on flush so
      // an 'updated' event fires and followers (tail -f) can subscribe, not poll.
      //
      // `sha256` is persisted in the same write, since it describes the content
      // at the same moment as the length. A `null` means the handle could not
      // see the whole file in order (append, read-write, a seek) and the attr is
      // cleared rather than left stale.
      const writable = mode.includes('w') || mode.includes('a') || mode.includes('+');
      if (writable && node.type === NODE_TYPE_FILE) {
        const path = entry.vfsAbsPath;
        let startSize = 0;
        try {
          startSize = await handle.size();
        } catch {
          startSize = 0;
        }
        // The mimetype was guessed at creation, usually from a name alone; once
        // the head of the file has actually been written it can be sniffed. Only
        // an untyped node is touched — a stored `image/x-canon-cr2`, from the name
        // or from exiftool, knows more than the sniffer ever will.
        const untyped = isUntypedMimetype((node.attrs as { mimetype?: string }).mimetype);
        return new SizeTrackingHandle(handle, async (size, sha256, head) => {
          try {
            // `writtenAt` is when the content last changed, which `modtime`
            // cannot say: it moves on every attr update too.
            const attrs: Record<string, unknown> = { size, sha256, writtenAt: new Date().toISOString() };
            if (untyped && head && head.length > 0) {
              attrs.mimetype = await getMimeFromBuffer(head, path);
            }
            await this.update(access, path, { attrs });
          } catch (error) {
            // The file can be removed while it is being written; its bookkeeping goes with it.
            if (error instanceof NodeNotFoundError) logger.debug('size tracking skipped, node deleted', { path });
            else logger.error('size tracking update failed', { error, path });
          }
        }, startSize);
      }

      // A position's shape is registry content with no attr describing it, so
      // the node is touched after the write to give subscribers an `updated`
      // event — with no attr changed, which is how a subscriber tells a moved
      // point from attr bookkeeping on the node.
      if (writable && node.type === NODE_TYPE_POSITION) {
        const path = entry.vfsAbsPath;
        return new ContentWriteHandle(handle, async () => {
          try {
            await this.update(access, path, { attrs: {} });
          } catch (error) {
            if (error instanceof NodeNotFoundError) logger.debug('position write report skipped, node deleted', { path });
            else logger.error('position write report failed', { error, path });
          }
        });
      }

      return handle;
    }

    return await entry.vfs.open(access, entry, opts);
  }

  async stat(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      tx?: Transaction;
    },
  ): Promise<ResourceStat> {
    const entry = await this.resolveEntry(access, ref, opts);

    if (entry.vfs === this) {
      const node = await this.store.getNode(entry.id, opts?.tx);

      assertAccess(access, node, 'r');

      const reg = this.regs[node.type as keyof VfsRegistries];

      if (!reg) {
        throw new NodeNotSupportedError(node.type);
      }

      // A path-addressed store's registry takes the path within the mount
      const id = this.store.pathAddressed ? entry.vfsAbsPath : entry.id;

      return await reg.stat(id, this.tierOpts(node) as any);
    }

    return await entry.vfs.stat(access, entry, opts);
  }

  async statX(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      tx?: Transaction;
    },
  ): Promise<ResourceStat> {
    const entry = await this.resolveEntry(access, ref, opts);

    if (entry.vfs === this) {
      const node = await this.store.getNode(entry.id, opts?.tx);

      assertAccess(access, node, 'r');

      const reg = this.regs[node.type as keyof VfsRegistries];

      if (!reg) {
        throw new NodeNotSupportedError(node.type);
      }

      // A path-addressed store's registry takes the path within the mount
      const id = this.store.pathAddressed ? entry.vfsAbsPath : entry.id;

      return await reg.statX(id, this.tierOpts(node) as any);
    }

    return await entry.vfs.statX(access, entry, opts);
  }

  async subscribe<T extends NodeAttrs = NodeAttrs>(
    getAccess: () => Promise<Access> | Access,
    handler: EventSubscriptionHandler<T>,
    filter?: EventSubscriptionFilter,
  ): Promise<EventSubscription> {
    return this.eventEmitter.subscribe<T>(getAccess, handler, filter);
  }

  setMounted(mounted: boolean): void {
    this.mounted = mounted;
  }

  async resolveEntry(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry> {
    if (typeof ref !== 'string') {
      return ref;
    }

    return await this.resolvePath(access, ref, opts);
  }
}
