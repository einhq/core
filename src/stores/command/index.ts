/**
 * Command store: the execution manager's command registry as a read-only directory, one
 * `command` node per registered command, its spec as the attrs.
 */

import { decodeBase64, encodeBase64 } from '@std/encoding';
import { ulid } from '@std/ulid/ulid';
import { ExecutionManager } from '../../managers/exec/mod.ts';
import { ADMIN_GID, ADMIN_UID } from '../../lib/access/mod.ts';
import {
  type ChildLinkFilter,
  NO_OP_TRANSACTION,
  type Node,
  type NodeAttrs,
  type NodeChild,
  type NodeChildEntry,
  type NodeId,
  NodeNotFoundError,
  type NodeStore,
  NodeStoreConfig,
  pageChildEntries,
  type Transaction,
} from '../../vfs/mod.ts';
import { CommandAttrs, NODE_TYPE_COMMAND } from '../../vfs/types/command.ts';
import { DirectoryAttrs, NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';

type CommandStoreConfig = NodeStoreConfig & {
  cem: ExecutionManager;
};

export class CommandStore implements NodeStore {
  readonly name = 'command';
  readonly type = 'readonly' as const;
  readonly rootId: NodeId;
  readonly supportsMount = false;

  private createdAt = Date.now();
  private rootNode: Node<DirectoryAttrs>;
  private initialized = false;
  private te = new TextEncoder();
  private td = new TextDecoder();

  constructor(public config: CommandStoreConfig) {
    this.rootId = this.config.rootId ?? ulid();

    this.rootNode = {
      id: this.rootId,
      type: NODE_TYPE_DIRECTORY,
      props: {
        mode: this.config.rootMode || 0o555,
        uid: ADMIN_UID,
        gid: ADMIN_GID,
        birthtime: { uid: ADMIN_UID, timestamp: this.createdAt },
        changetime: { uid: ADMIN_UID, timestamp: this.createdAt },
        modtime: { uid: ADMIN_UID, timestamp: this.createdAt },
        count: 0,
      },
      attrs: {},
    };
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }

  async isHealthy(): Promise<boolean> {
    return this.initialized;
  }

  // ===== Transaction Support =====

  async beginTransaction(): Promise<Transaction> {
    return NO_OP_TRANSACTION;
  }

  // ===== Core Operations =====

  async getNode<T extends NodeAttrs = NodeAttrs>(
    id: NodeId,
  ): Promise<Node<T>> {
    if (id === this.rootId) {
      return this.rootNode as Node<T>;
    }

    try {
      const name = this.decodeId(id);
      const spec = this.config.cem.get(name);

      if (!spec) {
        throw new NodeNotFoundError(id);
      }

      const mode = this.config.rootMode || 0o555;
      const node: Node<CommandAttrs> = {
        id,
        type: NODE_TYPE_COMMAND,
        props: {
          // An administrator's command is executable by its owner, the administrator, alone;
          // anyone may still read it.
          mode: spec.admin ? mode & 0o744 : mode,
          uid: ADMIN_UID,
          gid: ADMIN_GID,
          birthtime: { uid: ADMIN_UID, timestamp: this.createdAt },
          changetime: { uid: ADMIN_UID, timestamp: this.createdAt },
          modtime: { uid: ADMIN_UID, timestamp: this.createdAt },
          count: 1,
        },
        attrs: spec,
      };

      return node as Node<T>;
    } catch {
      throw new NodeNotFoundError(id);
    }
  }

  async getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    _tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]> {
    const entries: NodeChildEntry<T>[] = [];

    for (const link of await this.getChildLinks(parentId, opts)) {
      try {
        entries.push({
          node: await this.getNode<T>(link.id),
          name: link.name,
          position: link.position,
          childCount: 0, // commands are leaves
        });
      } catch {
        continue;
      }
    }

    return pageChildEntries(entries, opts);
  }

  /** The command registry is the hierarchy: every command is a child of root. */
  async getChildLinks(parentId: NodeId, opts?: ChildLinkFilter, _tx?: Transaction): Promise<NodeChild[]> {
    if (parentId !== this.rootId) {
      return [];
    }

    let links = this.config.cem.list().map<NodeChild>((spec, index) => ({
      id: this.encodeId(spec.name),
      name: spec.name,
      position: index + 1,
    }));

    if (opts?.name !== undefined) links = links.filter((link) => link.name === opts.name);
    if (opts?.childId !== undefined) links = links.filter((link) => link.id === opts.childId);

    return links;
  }

  async countChildren(parentId: NodeId, _tx?: Transaction): Promise<number> {
    return parentId === this.rootId ? this.config.cem.list().length : 0;
  }

  async getParents<T extends NodeAttrs = NodeAttrs>(
    childId: NodeId,
    _tx?: Transaction,
  ): Promise<Node<T>[]> {
    if (childId === this.rootId) {
      return [];
    }

    return [
      this.rootNode as Node<T>,
    ];
  }

  async exists(id: NodeId, _tx?: Transaction): Promise<boolean> {
    try {
      await this.getNode(id);
      return true;
    } catch {
      return false;
    }
  }

  private encodeId(name: string): string {
    const id = `${this.rootId}::${name}`;
    return encodeBase64(this.te.encode(id));
  }

  private decodeId(id: string): string {
    const decoded = this.td.decode(decodeBase64(id));
    const [, name] = decoded.split('::');
    return name;
  }
}
