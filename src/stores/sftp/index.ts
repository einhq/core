/**
 * SFTP Store
 *
 * A NodeStore reflecting a directory on an SFTP server: ids are the base64 of
 * the path within the mount (so they change when an entry moves), directories, files and symbolic links are the
 * node types, and nothing is kept but a cache of a couple of seconds.
 *
 * Every node is owned by the mount's uid/gid, whatever user owns it on the
 * server — remote numeric ids mean nothing here, and taken as they are they
 * would hand a file to whichever EiN user happens to share the number. The
 * permission bits come from the server.
 */

import * as posix from '@std/path/posix';
import { getMimeFromExt } from '../../lib/media/mod.ts';
import { Ownership, UserId } from '../../lib/mode/mod.ts';
import { type SftpAttrs, type SftpConnection, sftpKind, sftpTimeMs } from '../../lib/ssh/mod.ts';
import { NodeAlreadyExistsError, NodeNotFoundError } from '../../vfs/errors.ts';
import {
  type ChildLinkFilter,
  NO_OP_TRANSACTION,
  type Node,
  type NodeAttrs,
  type NodeAttrsUpdate,
  type NodeChild,
  type NodeChildEntry,
  type NodeId,
  type NodePropsCreate,
  type NodePropsUpdate,
  NodeStore,
  NodeStoreConfig,
  type NodeType,
  pageChildEntries,
  Transaction,
} from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';
import { decodePathId, encodePathId } from '../path-id.ts';

const NO_SUCH_FILE = 2;
/** Round trips issued at once when a listing needs one per entry */
const CONCURRENCY = 8;

type SftpStoreConfig = NodeStoreConfig & {
  /** Owner of every node in the mount */
  uid: number;
  gid: number;
  /**
   * Mount without waiting for the server (as at boot): the first connection is
   * tried in the background, and until one succeeds every operation fails with
   * why, then retries.
   */
  lazy?: boolean;
};

function isNotFound(error: unknown): boolean {
  return (error as { code?: number })?.code === NO_SUCH_FILE;
}

/** `fn` over `items`, at most `limit` at a time, results in order */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class SftpStore implements NodeStore {
  readonly name = 'sftp';
  readonly type = 'dynamic' as const;
  readonly supportsMount = false;
  readonly pathAddressed = true;

  private _rootId?: NodeId;

  constructor(public config: SftpStoreConfig, private conn: SftpConnection) {}

  get rootId(): NodeId {
    if (!this._rootId) throw new Error('sftp store not initialized');
    return this._rootId;
  }

  get source(): string {
    return this.conn.label;
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this._rootId) return;
    if (this.config.lazy) {
      // The connection logs its own failure and is retried on use
      this.conn.get().catch(() => {});
    } else {
      const sftp = await this.conn.get();
      const attrs = await sftp.stat(this.conn.root);
      if (sftpKind(attrs) !== 'directory') throw new Error(`${this.conn.label} is not a directory`);
    }
    this._rootId = encodePathId('/');
  }

  async dispose(): Promise<void> {
    this._rootId = undefined;
    await this.conn.close();
  }

  async isHealthy(): Promise<boolean> {
    // A lazy mount is there to wait for its server
    if (this.config.lazy) return !!this._rootId;
    try {
      const sftp = await this.conn.get();
      return sftpKind(await sftp.stat(this.conn.root)) === 'directory';
    } catch {
      return false;
    }
  }

  async beginTransaction(): Promise<Transaction> {
    return NO_OP_TRANSACTION;
  }

  // ===== Paths and attributes =====

  /** The path within the mount for one of our ids; NodeNotFoundError otherwise */
  private pathOf(id: NodeId): string {
    const path = decodePathId(id);
    if (path === null) throw new NodeNotFoundError(id);
    return path;
  }

  private async lstat(path: string, id: NodeId = encodePathId(path)): Promise<SftpAttrs> {
    const cached = this.conn.attrs.get(path);
    if (cached) return cached;
    try {
      const attrs = await (await this.conn.get()).lstat(this.conn.remote(path));
      this.conn.attrs.set(path, attrs);
      return attrs;
    } catch (error) {
      if (isNotFound(error)) throw new NodeNotFoundError(id);
      throw error;
    }
  }

  private async readdir(path: string, id: NodeId): Promise<{ filename: string; attrs: SftpAttrs }[]> {
    const cached = this.conn.dirs.get(path);
    if (cached) return cached;
    try {
      const entries = (await (await this.conn.get()).readdir(this.conn.remote(path)))
        .map((e) => ({ filename: e.filename, attrs: e.attrs as SftpAttrs }))
        .sort((a, b) => a.filename.localeCompare(b.filename));
      this.conn.dirs.set(path, entries);
      // The listing answered for each entry too
      for (const e of entries) this.conn.attrs.set(posix.join(path, e.filename), e.attrs);
      return entries;
    } catch (error) {
      if (isNotFound(error)) throw new NodeNotFoundError(id);
      throw error;
    }
  }

  private async readlink(path: string): Promise<string | undefined> {
    const cached = this.conn.links.get(path);
    if (cached !== undefined) return cached;
    try {
      const target = await (await this.conn.get()).readlink(this.conn.remote(path));
      this.conn.links.set(path, target);
      return target;
    } catch {
      return undefined;
    }
  }

  private async toNode<T extends NodeAttrs = NodeAttrs>(path: string, attrs: SftpAttrs): Promise<Node<T>> {
    const kind = sftpKind(attrs);
    const type: NodeType = kind === 'directory' ? NODE_TYPE_DIRECTORY : kind === 'link' ? NODE_TYPE_SOFTLINK : NODE_TYPE_FILE;
    const softlink = kind === 'link' ? await this.readlink(path) : undefined;

    const nodeAttrs: NodeAttrs = {};
    if (type === NODE_TYPE_FILE) {
      nodeAttrs.name = posix.basename(path);
      nodeAttrs.size = Number(attrs.size ?? 0);
      // By extension only: sniffing content would cost a read per file listed
      nodeAttrs.mimetype = await getMimeFromExt(path);
    }

    const { uid, gid } = this.config;
    const mtime = sftpTimeMs(attrs.mtime) ?? Date.now();
    return {
      id: encodePathId(path),
      type,
      props: {
        mode: attrs.mode ?? 0o644,
        uid,
        gid,
        // SFTP v3 knows no creation time
        birthtime: { uid, timestamp: mtime },
        changetime: { uid, timestamp: mtime },
        modtime: { uid, timestamp: mtime },
        count: 1,
        ...(softlink !== undefined ? { softlink } : {}),
      },
      attrs: nodeAttrs as T,
    };
  }

  // ===== Reads =====

  async getNode<T extends NodeAttrs = NodeAttrs>(id: NodeId): Promise<Node<T>> {
    const path = this.pathOf(id);
    return await this.toNode<T>(path, await this.lstat(path, id));
  }

  /**
   * A listing of one directory is one READDIR. `childCount` costs another per
   * subdirectory, so it is counted for a real listing only; a lookup by name or
   * id (every level of a path resolution) reports 0 rather than pay for it.
   */
  async getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    _tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]> {
    const links = await this.getChildLinks(parentId, opts);
    const parentPath = this.pathOf(parentId);
    const lookup = opts?.name !== undefined || opts?.childId !== undefined;

    const listing = await mapLimit(links, CONCURRENCY, async (link) => {
      const path = posix.join(parentPath, link.name);
      const attrs = await this.lstat(path, link.id);
      const node = await this.toNode<T>(path, attrs);
      const childCount = !lookup && node.type === NODE_TYPE_DIRECTORY ? await this.countChildren(link.id).catch(() => 0) : 0;
      return { node, name: link.name, position: link.position, childCount };
    });
    return pageChildEntries(listing, opts);
  }

  async getChildLinks(parentId: NodeId, opts?: ChildLinkFilter, _tx?: Transaction): Promise<NodeChild[]> {
    const parentPath = this.pathOf(parentId);

    // A lookup by name is one LSTAT, not a listing
    if (opts?.name !== undefined) {
      const path = posix.join(parentPath, opts.name);
      const id = encodePathId(path);
      if (opts.childId !== undefined && opts.childId !== id) return [];
      try {
        await this.lstat(path);
      } catch (error) {
        if (error instanceof NodeNotFoundError) return [];
        throw error;
      }
      return [{ id, name: opts.name }];
    }

    if (opts?.childId !== undefined) {
      const childPath = decodePathId(opts.childId);
      if (childPath === null || posix.dirname(childPath) !== parentPath) return [];
      try {
        await this.lstat(childPath);
      } catch (error) {
        if (error instanceof NodeNotFoundError) return [];
        throw error;
      }
      return [{ id: opts.childId, name: posix.basename(childPath) }];
    }

    const parentAttrs = await this.lstat(parentPath, parentId);
    if (sftpKind(parentAttrs) !== 'directory') return [];

    const entries = await this.readdir(parentPath, parentId);
    return entries.map((e, i) => ({ id: encodePathId(posix.join(parentPath, e.filename)), name: e.filename, position: i + 1 }));
  }

  /** One LSTAT per id not already answered by a listing; an id that is not there is absent. */
  async getOwnership(ids: NodeId[], _tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const result = new Map<NodeId, Ownership>();
    const { uid, gid } = this.config;
    await mapLimit([...new Set(ids)], CONCURRENCY, async (id) => {
      const path = decodePathId(id);
      const attrs = path === null ? undefined : await this.lstat(path, id).catch(() => undefined);
      if (attrs) result.set(id, { mode: attrs.mode ?? 0o644, uid, gid });
    });
    return result;
  }

  async countChildren(parentId: NodeId, _tx?: Transaction): Promise<number> {
    const path = this.pathOf(parentId);
    if (sftpKind(await this.lstat(path, parentId)) !== 'directory') return 0;
    return (await this.readdir(path, parentId)).length;
  }

  /** The parent is the directory above: no round trip to know it */
  async getParentLinks(childId: NodeId, _tx?: Transaction): Promise<{ parentId: NodeId; name: string }[]> {
    const path = this.pathOf(childId);
    if (path === '/') return [];
    return [{ parentId: encodePathId(posix.dirname(path)), name: posix.basename(path) }];
  }

  async getParents<T extends NodeAttrs = NodeAttrs>(childId: NodeId, _tx?: Transaction): Promise<Node<T>[]> {
    const links = await this.getParentLinks(childId);
    return await Promise.all(links.map((link) => this.getNode<T>(link.parentId)));
  }

  async exists(id: NodeId, _tx?: Transaction): Promise<boolean> {
    const path = decodePathId(id);
    if (path === null) return false;
    try {
      await this.lstat(path, id);
      return true;
    } catch (error) {
      if (error instanceof NodeNotFoundError) return false;
      throw error;
    }
  }

  // ===== Writes =====

  async createNode<T extends NodeAttrs = NodeAttrs>(
    _uid: UserId,
    type: NodeType,
    parentId: NodeId,
    name: string,
    props: NodePropsCreate,
    _attrs?: T,
  ): Promise<Node<T>> {
    const parentPath = this.pathOf(parentId);
    if (sftpKind(await this.lstat(parentPath, parentId)) !== 'directory') throw new Error('parent is not a directory');

    const path = posix.join(parentPath, name);
    if (await this.exists(encodePathId(path))) throw new NodeAlreadyExistsError(parentId, name);

    const sftp = await this.conn.get();
    const remote = this.conn.remote(path);
    const mode = props.mode !== undefined ? props.mode & 0o7777 : undefined;

    switch (type) {
      case NODE_TYPE_DIRECTORY:
        await sftp.mkdir(remote, { mode: mode ?? 0o755 });
        break;
      case NODE_TYPE_FILE:
        // Exclusive: someone else creating it at the same moment is a clash.
        // The VFS's default mode has execute bits (0770, for directories'
        // sake); a file on the server should not become executable by it.
        await sftp.close(await sftp.open(remote, 'wx', { mode: (mode ?? 0o644) & 0o666 }));
        break;
      case NODE_TYPE_SOFTLINK:
        if (!props.softlink) throw new Error('softlink requires a target path in props.softlink');
        await sftp.symlink(props.softlink, remote);
        break;
      default:
        throw new Error(`unsupported node type for sftp: ${type}`);
    }

    this.conn.invalidate(path);
    return await this.toNode<T>(path, await this.lstat(path));
  }

  /** Mode and a link's target are what the server keeps; attrs are derived, not stored */
  async updateNode<T extends NodeAttrs = NodeAttrs>(
    _uid: UserId,
    id: NodeId,
    props?: NodePropsUpdate,
    _attrs?: NodeAttrsUpdate<T>,
  ): Promise<Node<T>> {
    const path = this.pathOf(id);
    const attrs = await this.lstat(path, id);
    const sftp = await this.conn.get();
    const remote = this.conn.remote(path);
    const isLink = sftpKind(attrs) === 'link';

    if (props?.mode !== undefined && !isLink) {
      await sftp.chmod(remote, props.mode & 0o7777);
    }
    if (props?.softlink !== undefined && isLink) {
      await sftp.unlink(remote);
      await sftp.symlink(props.softlink, remote);
    }

    this.conn.invalidate(path);
    return await this.toNode<T>(path, await this.lstat(path, id));
  }

  // ===== Hierarchy writes =====
  //
  // The server's directories are the hierarchy: createNode/deleteNode have
  // already made an edge exist or not.

  async linkChild(_uid: UserId, parentId: NodeId, childId: NodeId, name: string): Promise<void> {
    if (encodePathId(posix.join(this.pathOf(parentId), name)) === childId) return;
    throw new Error(`hard links are not supported on an sftp mount: ${name}`);
  }

  async unlinkChild(): Promise<void> {}

  async moveChild(_uid: UserId, oldParentId: NodeId, oldName: string, newParentId: NodeId, newName: string): Promise<void> {
    const from = posix.join(this.pathOf(oldParentId), oldName);
    const to = posix.join(this.pathOf(newParentId), newName);
    const sftp = await this.conn.get();
    // The VFS has already decided a file in the way may be replaced. OpenSSH's
    // posix-rename does that atomically; plain SFTP v3 RENAME refuses an
    // existing target, so without the extension the file goes first.
    const atomic = sftp.extensions['posix-rename@openssh.com'] === '1';

    if (!atomic) {
      try {
        const existing = await this.lstat(to);
        if (sftpKind(existing) !== 'directory') await sftp.unlink(this.conn.remote(to));
      } catch (error) {
        if (!(error instanceof NodeNotFoundError)) throw error;
      }
    }

    try {
      if (atomic) await sftp.posixRename(this.conn.remote(from), this.conn.remote(to));
      else await sftp.rename(this.conn.remote(from), this.conn.remote(to));
    } catch (error) {
      if (isNotFound(error)) throw new NodeNotFoundError(`${oldName} in ${oldParentId}`);
      throw error;
    } finally {
      this.conn.invalidate(from);
      this.conn.invalidate(to);
    }
  }

  async deleteNode(_uid: UserId, id: NodeId): Promise<boolean> {
    const path = this.pathOf(id);
    if (path === '/') throw new Error('cannot delete the root of an sftp mount');

    let attrs: SftpAttrs;
    try {
      attrs = await this.lstat(path, id);
    } catch (error) {
      if (error instanceof NodeNotFoundError) return false;
      throw error;
    }

    const sftp = await this.conn.get();
    try {
      if (sftpKind(attrs) === 'directory') await sftp.rmdir(this.conn.remote(path));
      else await sftp.unlink(this.conn.remote(path));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    } finally {
      this.conn.invalidate(path);
    }
  }
}
