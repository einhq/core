/**
 * In-memory store: the router-only root, scratch mounts such as `/tmp`, and tests. Nothing in it
 * outlives the process.
 */

import { ulid } from '@std/ulid/ulid';
import { type Access, ADMIN_GID, ADMIN_UID, verifyAccess } from '../../lib/access/mod.ts';
import { GroupId, Ownership, UserId } from '../../lib/mode/mod.ts';
import {
  type AggregateBucket,
  auditMatches,
  type AuditQuery,
  type AuditRecord,
  type ChildLinkFilter,
  type EdgeMove,
  namedBy,
  type NewChild,
  NO_OP_TRANSACTION,
  type Node,
  NodeAlreadyExistsError,
  type NodeAttrs,
  type NodeAttrsUpdate,
  type NodeChild,
  type NodeChildEntry,
  type NodeId,
  NodeNotFoundError,
  type NodePath,
  type NodePropsCreate,
  type NodePropsUpdate,
  type NodeQueryRow,
  type NodeStore,
  NodeStoreConfig,
  type NodeType,
  type NodeUpdate,
  type OwnerRelease,
  pageChildEntries,
  type ParentLink,
  passesChanged,
  ReachClasses,
  type ReachGraph,
  type ReachRow,
  refreshReach,
  type ReleasedOwner,
  runAggregate,
  runQuery,
  type StoreAggregateQuery,
  type StoredPath,
  type StoreNodeQuery,
  type StoreScope,
  type Transaction,
} from '../../vfs/mod.ts';

/** Cycle guard for the upward path walk. */
const MAX_PATH_DEPTH = 64;

/**
 * A node as a bulk read returns it: a copy, as `getNode`'s is, so a write after the read does not
 * show through it, and without its link count, as PgStore's bulk reads have none.
 */
const snapshot = <T extends NodeAttrs>(node: Node<T>): Node<T> => {
  const copy = structuredClone(node);
  copy.props.count = 0;
  return copy;
};

/** Whether `target` is `path` or lies under it: `/a/b` covers `/a/b/c`, not `/a/bc`. */
const isAtOrUnder = (target: NodePath, path: NodePath): boolean => target === path || target.startsWith(path.endsWith('/') ? path : `${path}/`);

export class InMemoryStore implements NodeStore {
  readonly name = 'memory';
  readonly type = 'persistent' as const;
  readonly rootId: NodeId;
  readonly supportsMount = true;

  private nodes: Map<NodeId, Node> = new Map();
  /**
   * The hierarchy, parent → ordered child edges, kept beside the nodes so a node
   * read is independent of how many children it has.
   */
  private edges: Map<NodeId, NodeChild[]> = new Map();
  /** The audit trail, oldest first, when `auditing`. */
  private audit: AuditRecord[] = [];
  /** Each node's reach (see `vfs/reach.ts`), a class of `classes`. */
  private reach = new Map<NodeId, number>();
  private classes: ReachClasses;
  private initialized = false;

  /** Off by default: a mounted `/tmp` would otherwise collect a trail nobody reads, forever. */
  readonly auditing: boolean;

  constructor(public config: NodeStoreConfig & { audit?: boolean }) {
    this.rootId = config.rootId ?? ulid();
    this.auditing = config.audit ?? false;
    let next = 0;
    this.classes = new ReachClasses(async () => ++next);
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create root node
    const now = Date.now();
    const rootNode: Node = {
      id: this.rootId,
      type: 'directory',
      props: {
        mode: this.config.rootMode || 0o755,
        uid: ADMIN_UID,
        gid: ADMIN_GID,
        birthtime: { uid: ADMIN_UID, timestamp: now },
        changetime: { uid: ADMIN_UID, timestamp: now },
        modtime: { uid: ADMIN_UID, timestamp: now },
        count: 0,
      },
      attrs: {},
    };

    this.nodes.set(this.rootId, rootNode);
    this.reach.set(this.rootId, await this.classes.reachOf([], true));
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.nodes.clear();
    this.edges.clear();
    this.reach.clear();
    this.audit = [];
    this.initialized = false;
  }

  async isHealthy(): Promise<boolean> {
    return this.initialized;
  }

  // ===== Transaction Support =====

  /** No real transactions: the VFS's locks are all a memory store needs. */
  async beginTransaction(): Promise<Transaction> {
    return NO_OP_TRANSACTION;
  }

  // ===== Audit Trail =====

  async appendAudit(records: AuditRecord[], _tx?: Transaction): Promise<void> {
    this.audit.push(...structuredClone(records));
  }

  async queryAudit(query: AuditQuery): Promise<AuditRecord[]> {
    const limit = query.limit ?? 100;
    if (query.after !== undefined) {
      // Records are appended as their writes commit, which is not always in id order.
      const matching = this.audit.filter((record) => auditMatches(record, query));
      return matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit).map((record) => structuredClone(record));
    }
    const result: AuditRecord[] = [];
    for (let i = this.audit.length - 1; i >= 0 && result.length < limit; i--) {
      if (auditMatches(this.audit[i], query)) result.push(structuredClone(this.audit[i]));
    }
    return result;
  }

  // ===== Core Operations =====

  async getNode<T extends NodeAttrs = NodeAttrs>(
    id: NodeId,
    _tx?: Transaction,
  ): Promise<Node<T>> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new NodeNotFoundError(id);
    }
    // Return a snapshot — callers (e.g. event emission) must not observe
    // later mutations, matching the PostgreSQL store's behavior
    return structuredClone(node) as Node<T>;
  }

  async getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    _tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]> {
    if (!this.nodes.has(parentId)) {
      throw new NodeNotFoundError(parentId);
    }

    const entries: NodeChildEntry<T>[] = [];

    for (const link of await this.getChildLinks(parentId, opts)) {
      const node = this.nodes.get(link.id);
      if (!node) continue; // skip dangling edges

      entries.push({
        node: structuredClone(node) as Node<T>,
        name: link.name,
        position: link.position,
        childCount: this.edges.get(link.id)?.length ?? 0,
      });
    }

    return pageChildEntries(entries, opts);
  }

  async getChildrenMany<T extends NodeAttrs = NodeAttrs>(
    parentIds: NodeId[],
    _tx?: Transaction,
  ): Promise<Map<NodeId, NodeChildEntry<T>[]>> {
    const result = new Map<NodeId, NodeChildEntry<T>[]>();
    for (const parentId of new Set(parentIds)) {
      if (!this.edges.get(parentId)?.length) continue;
      result.set(parentId, await this.getChildren<T>(parentId));
    }
    return result;
  }

  async getChildLinks(parentId: NodeId, opts?: ChildLinkFilter, _tx?: Transaction): Promise<NodeChild[]> {
    let links = this.edges.get(parentId) ?? [];

    if (opts?.name !== undefined) links = links.filter((link) => link.name === opts.name);
    if (opts?.childId !== undefined) links = links.filter((link) => link.id === opts.childId);

    return links.map((link) => ({ ...link }));
  }

  async findChildLinks(edges: ParentLink[], _tx?: Transaction): Promise<(ParentLink & { id: NodeId })[]> {
    const found: (ParentLink & { id: NodeId })[] = [];
    for (const { parentId, name } of edges) {
      const link = this.edges.get(parentId)?.find((link) => link.name === name);
      if (link) found.push({ parentId, name, id: link.id });
    }
    return found;
  }

  async countChildren(parentId: NodeId, _tx?: Transaction): Promise<number> {
    return this.edges.get(parentId)?.length ?? 0;
  }

  async countReadableChildren(reader: Access, parentIds: NodeId[], _tx?: Transaction): Promise<Map<NodeId, number>> {
    const result = new Map<NodeId, number>();
    for (const parentId of new Set(parentIds)) {
      const count = (this.edges.get(parentId) ?? []).filter((link) => {
        const node = this.nodes.get(link.id);
        return node !== undefined && verifyAccess(reader, node.props, 'r');
      }).length;
      if (count > 0) result.set(parentId, count);
    }
    return result;
  }

  async getParents<T extends NodeAttrs = NodeAttrs>(
    childId: NodeId,
    _tx?: Transaction,
  ): Promise<Node<T>[]> {
    const parents: Node<T>[] = [];

    for (const [parentId, links] of this.edges) {
      if (!links.some((link) => link.id === childId)) continue;
      const parent = this.nodes.get(parentId);
      if (parent) parents.push(parent as Node<T>);
    }

    return parents;
  }

  async getParentLinks(childId: NodeId, _tx?: Transaction): Promise<{ parentId: NodeId; name: string }[]> {
    const links: { parentId: NodeId; name: string }[] = [];
    for (const [parentId, childLinks] of this.edges) {
      for (const link of childLinks) {
        if (link.id === childId) links.push({ parentId, name: link.name });
      }
    }
    return links;
  }

  /** One walk over the edges for the whole batch, rather than one per id. */
  async getParentLinksMany(
    childIds: NodeId[],
    _tx?: Transaction,
  ): Promise<Map<NodeId, { parentId: NodeId; name: string }[]>> {
    const wanted = new Set(childIds);
    const result = new Map<NodeId, { parentId: NodeId; name: string }[]>();
    if (wanted.size === 0) return result;

    for (const [parentId, childLinks] of this.edges) {
      for (const link of childLinks) {
        if (!wanted.has(link.id)) continue;
        const entry = { parentId, name: link.name };
        const links = result.get(link.id);
        if (links) links.push(entry);
        else result.set(link.id, [entry]);
      }
    }

    return result;
  }

  async exists(id: NodeId, _tx?: Transaction): Promise<boolean> {
    return this.nodes.has(id);
  }

  // ===== Write Operations =====

  async createNode<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    type: NodeType,
    parentId: NodeId,
    name: string,
    props: NodePropsCreate,
    attrs?: T,
    _tx?: Transaction,
  ): Promise<Node<T>> {
    if (!parentId) {
      throw new Error('Parent ID is required');
    }

    if (!this.nodes.has(parentId)) {
      throw new NodeNotFoundError(parentId);
    }

    const id = ulid();
    const now = Date.now();

    const node: Node<T> = {
      id,
      type,
      props: {
        birthtime: { uid, timestamp: now },
        changetime: { uid, timestamp: now },
        modtime: { uid, timestamp: now },
        // `linkChild` below makes it 1 — the edge naming it under the parent.
        count: 0,
        ...props,
      },
      attrs: attrs || ({} as T),
    };

    this.nodes.set(id, node);

    try {
      this.addEdge(parentId, id, name);
    } catch (error) {
      this.nodes.delete(id);
      throw error;
    }
    const parent = this.nodes.get(parentId)!;
    this.reach.set(id, await this.classes.under({ reach: this.reach.get(parentId) ?? null, ownership: parent.props }));

    return structuredClone(node);
  }

  /** Every name checked before the first is made, so a taken one makes none. */
  async createNodes<T extends NodeAttrs = NodeAttrs>(uid: UserId, parentId: NodeId, children: NewChild<T>[], tx?: Transaction): Promise<Node<T>[]> {
    if (!this.nodes.has(parentId)) throw new NodeNotFoundError(parentId);
    const names = new Set((this.edges.get(parentId) ?? []).map((link) => link.name));
    for (const { name } of children) {
      if (names.has(name)) throw new NodeAlreadyExistsError(parentId, name);
      names.add(name);
    }
    const created: Node<T>[] = [];
    for (const child of children) created.push(await this.createNode<T>(uid, child.type, parentId, child.name, child.props, child.attrs, tx));
    return created;
  }

  async updateNode<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    id: NodeId,
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    _tx?: Transaction,
  ): Promise<Node<T>> {
    const node = (await this.updateNodes<T>(uid, [id], props, attrs)).get(id);
    if (!node) {
      throw new NodeNotFoundError(id);
    }
    return node;
  }

  /** A props change stamps `changetime`, an attrs change `modtime`, as in PgStore. */
  async updateNodes<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    ids: NodeId[],
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    _tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const result = new Map<NodeId, Node<T>>();
    const now = Date.now();

    // A prop left undefined is left alone, not cleared.
    const changes = Object.fromEntries(Object.entries(props ?? {}).filter(([, value]) => value !== undefined));
    const propsChanged = Object.keys(changes).length > 0;
    /** Nodes now letting through others than before: what is below them is refreshed. */
    const regranted: NodeId[] = [];

    for (const id of new Set(ids)) {
      // Mutate the stored node directly (getNode returns snapshots)
      const node = this.nodes.get(id) as Node<T> | undefined;
      if (!node) continue;

      if (propsChanged) {
        const before = { ...node.props };
        // Copied per node, so no two stored nodes share an ACL array.
        Object.assign(node.props, structuredClone(changes));
        node.props.changetime = { uid, timestamp: now };
        if (passesChanged(before, node.props)) regranted.push(id);
      }

      // A null or undefined value removes the key (see NodeAttrsUpdate) — Object.assign alone
      // would store it, which reads back as "present" and keeps the key in every listing.
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          if (value === null || value === undefined) delete (node.attrs as Record<string, unknown>)[key];
          else (node.attrs as Record<string, unknown>)[key] = structuredClone(value);
        }
        node.props.modtime = { uid, timestamp: now };
      }

      result.set(id, structuredClone(node));
    }
    await this.refreshBelow(regranted);

    return result;
  }

  async updateNodesEach<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    changes: NodeUpdate<T>[],
    _tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const result = new Map<NodeId, Node<T>>();
    for (const change of changes) {
      for (const [id, node] of await this.updateNodes<T>(uid, [change.id], change.props, change.attrs)) result.set(id, node);
    }
    return result;
  }

  async deleteNode(
    _uid: UserId,
    id: NodeId,
    _tx?: Transaction,
  ): Promise<boolean> {
    if ((this.edges.get(id)?.length ?? 0) > 0) {
      throw new Error('node not empty');
    }

    this.nodes.delete(id);
    this.edges.delete(id);
    this.reach.delete(id);

    // Drop any edge pointing at it, so nothing dangles
    for (const [parentId, links] of this.edges) {
      const remaining = links.filter((link) => link.id !== id);
      if (remaining.length !== links.length) this.edges.set(parentId, remaining);
    }

    return true;
  }

  // ===== Hierarchy Writes =====

  async linkChild(
    _uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    _tx?: Transaction,
  ): Promise<void> {
    this.addEdge(parentId, childId, name);
    await refreshReach(this.reachGraph(), [childId]);
  }

  /** The link count is maintained here, with the edge, rather than written back by the VFS. */
  private addEdge(parentId: NodeId, childId: NodeId, name: string): void {
    const links = this.edges.get(parentId) ?? [];

    if (links.some((link) => link.name === name)) {
      throw new NodeAlreadyExistsError(parentId, name);
    }

    links.push({ id: childId, name, position: links.length + 1 });
    this.edges.set(parentId, links);

    const child = this.nodes.get(childId);
    if (child) child.props.count++;
  }

  async unlinkChild(
    _uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    _tx?: Transaction,
  ): Promise<void> {
    const links = this.edges.get(parentId);
    const index = links?.findIndex((link) => link.id === childId && link.name === name) ?? -1;
    if (index === -1) return;

    links!.splice(index, 1);

    const child = this.nodes.get(childId);
    if (child) child.props.count--;
    await refreshReach(this.reachGraph(), [childId]);
  }

  async moveChild(
    _uid: UserId,
    oldParentId: NodeId,
    oldName: string,
    newParentId: NodeId,
    newName: string,
    _tx?: Transaction,
  ): Promise<void> {
    const links = this.edges.get(oldParentId) ?? [];
    const index = links.findIndex((link) => link.name === oldName);

    if (index === -1) {
      throw new NodeNotFoundError(`${oldName} in ${oldParentId}`);
    }

    // A name is unique within its parent
    const target = this.edges.get(newParentId) ?? [];
    if (target.some((link) => link.name === newName && link !== links[index])) {
      throw new NodeAlreadyExistsError(newParentId, newName);
    }

    const [link] = links.splice(index, 1);
    this.edges.set(oldParentId, links);

    if (oldParentId === newParentId) {
      // In-place rename keeps its slot in the ordering
      links.splice(index, 0, { ...link, name: newName });
      return;
    }

    target.push({ id: link.id, name: newName, position: target.length + 1 });
    this.edges.set(newParentId, target);
    await refreshReach(this.reachGraph(), [link.id]);
  }

  async unlinkChildren(uid: UserId, edges: (ParentLink & { id: NodeId })[], tx?: Transaction): Promise<void> {
    for (const edge of edges) await this.unlinkChild(uid, edge.parentId, edge.id, edge.name, tx);
  }

  async deleteNodes(uid: UserId, ids: NodeId[], tx?: Transaction): Promise<void> {
    for (const id of ids) await this.deleteNode(uid, id, tx);
  }

  async moveChildren(uid: UserId, moves: EdgeMove[], tx?: Transaction): Promise<void> {
    for (const { from, to } of moves) await this.moveChild(uid, from.parentId, from.name, to.parentId, to.name, tx);
  }

  // ===== Attribute Queries =====

  async queryNodes<T extends NodeAttrs = NodeAttrs>(
    query: StoreNodeQuery,
    _tx?: Transaction,
  ): Promise<NodeQueryRow<T>[]> {
    const { withinId, notWithinIds, reader, ...rest } = query;
    return runQuery<T>(this.readable(this.scoped({ withinId, notWithinIds }), reader), rest);
  }

  async groupCount(
    query: StoreAggregateQuery,
    _tx?: Transaction,
  ): Promise<AggregateBucket[]> {
    const { withinId, notWithinIds, reader, ...rest } = query;
    return runAggregate(this.readable(this.scoped({ withinId, notWithinIds }), reader), rest);
  }

  /** Of `nodes`, those `reader` may read and reach; all of them without a reader. */
  private readable(nodes: Iterable<Node>, reader: Access | undefined): Iterable<Node> {
    if (reader === undefined) return nodes;
    const admitted = this.classes.admitted(reader);
    return [...nodes].filter((node) => admitted.has(this.reach.get(node.id)!) && verifyAccess(reader, node.props, 'r'));
  }

  async countWithin(rootId: NodeId, cap: number, _tx?: Transaction): Promise<number> {
    return Math.min(this.membersOf([rootId]).size, cap);
  }

  /** The nodes a scope admits: within `withinId` when given, and within none of `notWithinIds`. */
  private scoped(scope: StoreScope): Iterable<Node> {
    if (scope.withinId === undefined && !scope.notWithinIds?.length) return this.nodes.values();
    const within = scope.withinId === undefined ? undefined : this.membersOf([scope.withinId]);
    const excluded = scope.notWithinIds?.length ? this.membersOf(scope.notWithinIds) : undefined;
    return [...this.nodes.values()].filter((node) => (within === undefined || within.has(node.id)) && !excluded?.has(node.id));
  }

  /**
   * Every node within any of `rootIds` (see `NodeQuery.within`): their children, and the
   * children of every node below them that is neither a file nor a softlink.
   */
  private membersOf(rootIds: NodeId[]): Set<NodeId> {
    const members = new Set<NodeId>();
    const entered = new Set<NodeId>(rootIds);
    let level = rootIds.filter((id) => this.nodes.has(id));
    for (let depth = 0; level.length > 0 && depth <= MAX_PATH_DEPTH; depth++) {
      const next: NodeId[] = [];
      for (const id of level) {
        for (const link of this.edges.get(id) ?? []) {
          members.add(link.id);
          const child = this.nodes.get(link.id);
          if (!child || child.type === 'file' || child.props.softlink || entered.has(link.id)) continue;
          entered.add(link.id);
          next.push(link.id);
        }
      }
      level = next;
    }
    return members;
  }

  async findSoftlinks(targets: NodePath[], limit: number, _tx?: Transaction): Promise<Node[]> {
    const wanted = new Set(targets);
    const found: Node[] = [];

    for (const node of this.nodes.values()) {
      if (found.length >= limit) break;
      if (node.props.softlink && wanted.has(node.props.softlink)) found.push(snapshot(node));
    }

    return found;
  }

  async findSoftlinksUnder(paths: NodePath[], limit: number, _tx?: Transaction): Promise<Node[]> {
    const found: Node[] = [];

    for (const node of this.nodes.values()) {
      if (found.length >= limit) break;
      const target = node.props.softlink;
      if (target && paths.some((path) => isAtOrUnder(target, path))) found.push(snapshot(node));
    }

    return found;
  }

  async releaseOwner(release: OwnerRelease, changeUid: UserId): Promise<ReleasedOwner> {
    const released: ReleasedOwner = { owned: 0, acl: 0 };
    const now = Date.now();

    const regranted: NodeId[] = [];
    for (const node of this.nodes.values()) {
      const before = { ...node.props };
      const owned = node.props[release.kind] === release.id;
      const acl = node.props.acl?.filter((entry) => entry[release.kind] !== release.id);
      const granted = acl !== undefined && acl.length !== node.props.acl!.length;
      if (!owned && !granted) continue;

      if (owned) {
        node.props[release.kind] = release.to;
        released.owned++;
      }
      if (granted) {
        if (acl.length > 0) node.props.acl = acl;
        else delete node.props.acl;
        released.acl++;
      }
      node.props.changetime = { uid: changeUid, timestamp: now };
      if (passesChanged(before, node.props)) regranted.push(node.id);
    }
    await this.refreshBelow(regranted);

    return released;
  }

  async getNodes<T extends NodeAttrs = NodeAttrs>(
    ids: NodeId[],
    _tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>> {
    const result = new Map<NodeId, Node<T>>();
    for (const id of new Set(ids)) {
      const node = this.nodes.get(id);
      if (node) result.set(id, snapshot(node) as Node<T>);
    }
    return result;
  }

  async getOwnership(ids: NodeId[], _tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const result = new Map<NodeId, Ownership>();
    for (const id of new Set(ids)) {
      const props = this.nodes.get(id)?.props;
      if (props) result.set(id, { mode: props.mode, uid: props.uid, gid: props.gid, ...(props.acl ? { acl: props.acl } : {}) });
    }
    return result;
  }

  async reachable(access: Access, ids: NodeId[], tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const admitted = this.classes.admitted(access);
    const owners = await this.getOwnership(ids, tx);
    for (const id of owners.keys()) if (!admitted.has(this.reach.get(id)!)) owners.delete(id);
    return owners;
  }

  async reachNamed(): Promise<{ uids: UserId[]; gids: GroupId[] }> {
    return namedBy([...new Set(this.reach.values())].map((id) => this.classes.formula(id)!));
  }

  /** Refreshes the reach of the children of `ids` and below. */
  private async refreshBelow(ids: NodeId[]): Promise<void> {
    if (ids.length === 0) return;
    const graph = this.reachGraph();
    await refreshReach(graph, await graph.children(ids));
  }

  private reachGraph(): ReachGraph {
    return {
      rootId: this.rootId,
      classes: this.classes,
      rows: async (ids) => {
        const rows = new Map<NodeId, ReachRow>();
        for (const id of ids) if (this.nodes.has(id)) rows.set(id, { reach: this.reach.get(id) ?? null, parents: [] });
        for (const [parentId, links] of this.edges) {
          const parent = this.nodes.get(parentId);
          if (!parent) continue;
          for (const link of links) rows.get(link.id)?.parents.push({ reach: this.reach.get(parentId) ?? null, ownership: parent.props });
        }
        return rows;
      },
      children: async (ids) => [...new Set(ids.flatMap((id) => (this.edges.get(id) ?? []).map((link) => link.id)))],
      write: async (reaches) => {
        for (const [id, reach] of reaches) this.reach.set(id, reach);
      },
    };
  }

  /**
   * Batch path resolution. Builds the child→(parent, name) edge map once and
   * walks each id up, so N ids cost one pass over the node set rather than the
   * per-id scan `getParents` does.
   */
  async resolvePaths(ids: NodeId[], _tx?: Transaction): Promise<Map<NodeId, StoredPath[]>> {
    const result = new Map<NodeId, StoredPath[]>();
    if (ids.length === 0) return result;

    const edges = new Map<NodeId, { parentId: NodeId; name: string }[]>();
    for (const [parentId, links] of this.edges) {
      for (const link of links) {
        const existing = edges.get(link.id);
        const edge = { parentId, name: link.name };
        if (existing) existing.push(edge);
        else edges.set(link.id, [edge]);
      }
    }

    // Prefixes only, each with the ids of the path to `id` inclusive; the direct
    // parent is known at the top level below.
    type Prefix = { path: string; ids: NodeId[] };
    const prefixesFor = (id: NodeId, depth: number): Prefix[] => {
      if (id === this.rootId) return [{ path: '', ids: [id] }];
      if (depth > MAX_PATH_DEPTH) return [];
      const parents = edges.get(id);
      if (!parents) return [];

      const prefixes: Prefix[] = [];
      for (const edge of parents) {
        for (const prefix of prefixesFor(edge.parentId, depth + 1)) {
          prefixes.push({ path: `${prefix.path}/${edge.name}`, ids: [...prefix.ids, id] });
        }
      }
      return prefixes;
    };

    for (const id of new Set(ids)) {
      if (id === this.rootId) {
        result.set(id, [{ path: '/', parentId: this.rootId, ancestors: [] }]);
        continue;
      }

      const resolved: StoredPath[] = [];
      for (const edge of edges.get(id) ?? []) {
        for (const prefix of prefixesFor(edge.parentId, 0)) {
          resolved.push({ path: `${prefix.path}/${edge.name}`, parentId: edge.parentId, ancestors: prefix.ids });
        }
      }
      if (resolved.length > 0) result.set(id, resolved);
    }

    return result;
  }
}
