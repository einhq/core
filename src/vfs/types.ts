import { Ownership, UserId } from '../lib/mode/mod.ts';
import { NullPartial } from '../types.ts';
import type { EmbeddingRegistryIf } from '../registries/embedding/types.ts';
import type { FileRegistryIf } from '../registries/file/types.ts';
import type { PositionRegistryIf } from '../registries/position/types.ts';
import type { LogRegistryIf } from '../registries/log/types.ts';
import type { RegistryIf } from '../registries/types.ts';
import type { PoolRegistryIf } from '../registries/pool/types.ts';
import type { QueueRegistryIf } from '../registries/queue/types.ts';
import type { RouterRegistryIf } from '../registries/router/types.ts';
import type { TrackRegistryIf } from '../registries/track/types.ts';
import { NodeVFS } from './node-vfs.ts';
import { Node, NodeAttrs, NodeChild, NodeId, NodePath, NodeSpecialProps, NodeType, UserTime } from './node.ts';

export type VfsRegistries = {
  router?: RouterRegistryIf;
  embedding?: EmbeddingRegistryIf;
  file?: FileRegistryIf;
  position?: PositionRegistryIf;
  log?: LogRegistryIf;
  null?: RegistryIf;
  pool?: PoolRegistryIf;
  queue?: QueueRegistryIf;
  track?: TrackRegistryIf;
};

/**
 * Event subscription handle
 */
export type EventSubscription = {
  unsubscribe(): Promise<void>;
};

export type Mount = {
  point: NodeEntry;
  vfs: NodeVFS;
  mounted: UserTime;
  options?: {
    readonly?: boolean;
    /**
     * False keeps the mount's events off the router (queues, pipeline
     * triggers, the archive bridge) while in-process subscribers still get them.
     * For a mirror of storage elsewhere (an SFTP server): a pipeline would try
     * to give its files children, which such a store cannot hold.
     */
    publish?: boolean;
  };
};

export type NodeEntry = {
  id: NodeId;
  vfs: NodeVFS;
  vfsAbsPath: NodePath;
  absPath: NodePath;
};

export type NodeReference = NodePath | NodeEntry;

/**
 * One entry in a directory listing.
 *
 * This — not the node — is where hierarchy facts live. `childCount` is the
 * entry's own number of children, those the caller may read unless the listing
 * asked for all (`ChildCountOptions`); `children` holds its child edges and is only
 * populated when the listing was asked for them (`ChildrenOptions.childLinks`).
 */
export type NodeChildEntry<T extends NodeAttrs = NodeAttrs> = {
  node: Node<T>;
  name: string;
  position?: number; // Order within parent
  childCount: number;
  children?: NodeChild[];
};

/**
 * Node props for create
 *
 * birthtime is optional; when omitted the store stamps creation time. Import
 * paths set it to preserve the original creation time/creator.
 */
export type NodePropsCreate = Ownership & NodeSpecialProps & {
  birthtime?: UserTime;
};

/**
 * Partial node props update
 *
 * No hierarchy: edges change through `NodeStore.linkChild` / `unlinkChild` /
 * `moveChild` and their batched forms, and `count`, being the number of those
 * edges, is maintained by the store along with them.
 */
export type NodePropsUpdate = Partial<Ownership & NodeSpecialProps>;

/**
 * Attr update. Stores merge this into the existing attrs, so an omitted key is left
 * untouched — that is what makes it a patch rather than a replace. A key set to `null`
 * or `undefined` means *remove it*: without that there is no way to express deletion at
 * all, because omitting the key is indistinguishable from "don't change it".
 */
export type NodeAttrsUpdate<T extends NodeAttrs = NodeAttrs> = NullPartial<T>;

/** What `updateMany` gives every node, and how it goes about it. */
export type UpdateManyOptions<T extends NodeAttrs = NodeAttrs> = NodeResolveOptions & {
  props?: NodePropsUpdate;
  attrs?: NodeAttrsUpdate<T>;
  /**
   * Asked of each node as it stands under its lock, after `update`'s own checks; a throw refuses
   * that node alone. It holds a write made with more authority than the caller's to the nodes the
   * caller could write.
   */
  guard?: (node: Node) => void;
  /** Checked between batches: once it aborts, every node not yet reached is refused with its reason. */
  signal?: AbortSignal;
};

/** One node's change in `updateEach`: the node, how its ref is resolved, and what it is given. */
export type NodeChange<T extends NodeAttrs = NodeAttrs> = NodeResolveOptions & {
  ref: NodeReference;
  props?: NodePropsUpdate;
  attrs?: NodeAttrsUpdate<T>;
};

/**
 * One move of `renameMany`: the node at `from` goes to `to`. A VFS that hands moves on to a mount
 * gives them as parent entries and names, which keep the caller's paths.
 */
export type RenameMove =
  | { from: NodePath; to: NodePath }
  | { fromParent: NodeEntry; fromName: string; toParent: NodeEntry; toName: string };

export type RenameManyOptions = {
  /** Refuse a move onto a taken name, instead of replacing the node there as `rename` does. */
  failIfExists?: boolean;
  /** Re-point the softlinks at or under each moved path. Default true. */
  relink?: boolean;
  /** Checked between chunks: once it aborts, every move not yet made is refused with its reason. */
  signal?: AbortSignal;
};

/**
 * One edge `unlinkMany` removes: the node at a path, or, as a VFS hands it on to a mount, the
 * child `name` of a parent entry.
 */
export type UnlinkTarget = NodePath | { parent: NodeEntry; name: string };

/** What one move of `renameMany` did. */
export type RenamedNode<T extends NodeAttrs = NodeAttrs> = {
  /** The node at its new path. It carries no link count (`count` 0). */
  node: Node<T>;
  /** Softlinks re-pointed because of this move: those whose target was at or under its path. */
  relinked: number;
  /** The source was already gone and the destination there: a move an earlier call made. */
  already?: true;
};

/**
 * One node in a `createTree` spec: what to make, what to name it, and what
 * hangs under it.
 */
export type NodeTreeSpec<T extends NodeAttrs = NodeAttrs> = {
  type: NodeType;
  name: string;
  props?: Partial<NodePropsCreate>;
  attrs?: T;
  children?: NodeTreeSpec[];
};

export type NodeResolveOptions = {
  /**
   * Don't follow any softlinks, treat softlink as ordinary nodes,
   * default true
   */
  follow?: boolean;

  /**
   * If the resolved node is a softlink return that node not the
   * one it points to, default false.
   */
  readlink?: boolean;

  /**
   * If the resolved node is a mount point return the node not the
   * root of the mounted vfs, default false.
   */
  readmount?: boolean;
};

/**
 * Which children a count covers. A count — `childCount`, and each listed entry's `childCount` —
 * covers the children the caller may read, as a listing lists them; `all` counts the others too.
 * Only a change that must not leave children behind asks for it: refusing to remove or replace a
 * directory that is not empty, or noticing that a listing left some out.
 */
export type ChildCountOptions = {
  all?: boolean;
};

/**
 * Options for filtering children
 */
export type ChildrenOptions = ChildCountOptions & {
  filter?: {
    name?: string | RegExp; // Glob pattern or regex for name matching
  };

  /**
   * One page of the listing: `limit` children in name order (the store's
   * collation), after the one named `after` — pass the last name of a page to
   * read the next. Fewer than `limit` means the listing has ended. Not with
   * `filter`, which is applied after the store has read.
   */
  page?: { limit: number; after?: string };

  /** Only the children of these node types, chosen by the store. */
  types?: NodeType[];

  /**
   * Also populate each entry's own child edges (`NodeChildEntry.children`),
   * those to children the caller may read. Off by default: it is a second lookup, and only callers that need to know
   * *what* a listed node contains (rather than how much) want it.
   */
  childLinks?: boolean;
};

/**
 * Options for copy operations
 */
export type CopyOptions = {
  /** Copy children recursively (default: false) */
  recursive?: boolean;
  /** Overwrite existing node at destination (default: false) */
  overwrite?: boolean;
  /** Maximum recursion depth (default: 100) */
  maxDepth?: number;
};

/**
 * Node events.
 *
 * `created`, `updated`, `deleted` and `moved` carry the node they name.
 * `child-attached` and `child-detached` carry the **parent** — they are facts
 * about a container's membership, whichever operation changed it (`create`,
 * `link`, `mv`, `unlink`) — so they publish on the parent's type
 * (`system.vfs.album.child-attached`) and a consumer that cares about one kind
 * of container binds one key. The child is named by its own `created`/`moved`
 * event when it has one; a hard link has none, which is why the parent is the
 * half worth carrying. One write announces each container's change once, however
 * many children it attached or detached there.
 */
export type NodeEventType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'child-attached'
  | 'child-detached'
  | 'moved';

export type NodeEvent<T extends NodeAttrs = NodeAttrs> = {
  id: string; // Event ID
  type: NodeEventType;
  path: NodePath;
  node: Node<T>; // Current state
  previousNode?: Node<T>; // Previous state (for updates)
  /** Where the node was before, on a `moved` event only. */
  fromPath?: NodePath;
  timestamp: number;
  uid: UserId;
  /** Id of the audit record the write behind this event left, when it left one. */
  auditId?: string;
  /** From a mount with `publish: false`: delivered in-process, never put on the router */
  unpublished?: true;
};

/** Prefix shared by every VFS event routing key. */
const VFS_ROUTING_KEY_PREFIX = 'system.vfs';

/**
 * Routing key a VFS event is published on: `system.vfs.<nodeType>.<eventType>`.
 *
 * Deliberately granular: a consumer that binds `system.vfs.file.updated` never
 * pays for the directory, embedding and tty churn a media crawl generates.
 */
export const vfsRoutingKey = (nodeType: NodeType, eventType: NodeEventType): string => `${VFS_ROUTING_KEY_PREFIX}.${nodeType}.${eventType}`;

/**
 * Filter options for event subscriptions
 */
export type EventSubscriptionFilter = {
  /** Filter by specific event types */
  eventTypes?: NodeEventType[];
  /** Filter by path prefix (events under this path) */
  pathPrefix?: NodePath;
  /** Include events from descendants when using pathPrefix (default: true) */
  recursive?: boolean;
  /** Filter by node types */
  nodeTypes?: NodeType[];
};

export type EventSubscriptionHandler<T extends NodeAttrs = NodeAttrs> = (event: NodeEvent<T>) => void | Promise<void>;
