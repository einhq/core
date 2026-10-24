/**
 * Filesystem Store
 *
 * A NodeStore implementation that reflects a host filesystem directory in real-time.
 * Uses base64-encoded relative paths as IDs for O(1) lookups.
 * Note: IDs will change if files are moved/renamed.
 * No caching - every operation reads directly from the filesystem.
 *
 * Supported node types: directory, file, softlink
 */

import { basename, join, normalize, relative } from '@std/path';
import { getMimeFromBuffer, getMimeFromExt, MIME_DEFAULT_TYPE, MIME_SAMPLE_BYTES } from '../../lib/media/mod.ts';
import { Ownership, UserId } from '../../lib/mode/mod.ts';
import { decodePathId as decodeId, encodePathId as encodeId } from '../path-id.ts';
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
  type PathEntry,
  type PathNode,
  type ResolvedNodeChain,
  Transaction,
} from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';

// ===== Types =====

type WalkEntry = {
  absolutePath: string;
  relativePath: string;
  stat: Deno.FileInfo;
};

// ===== FilesystemStore Implementation =====

type FilesystemStoreConfig = NodeStoreConfig & {
  rootPath: string;
};

/** Exposes a host filesystem directory as a VFS store. */
export class FilesystemStore implements NodeStore {
  readonly name = 'filesystem';
  readonly type = 'dynamic' as const;
  readonly supportsMount = false;
  readonly pathAddressed = true;

  private _rootId?: NodeId;
  private initialized = false;
  private rootPath: string;

  constructor(public config: FilesystemStoreConfig) {
    // Normalize the root path
    this.rootPath = normalize(config.rootPath);
  }

  get rootId(): NodeId {
    if (!this._rootId) {
      throw new Error('FilesystemStore not initialized');
    }
    return this._rootId;
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Verify root path exists and is a directory
    const stat = await Deno.lstat(this.rootPath);
    if (!stat.isDirectory) {
      throw new Error(`Root path is not a directory: ${this.rootPath}`);
    }

    // Root has empty relative path
    this._rootId = encodeId('/');
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this._rootId = undefined;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.initialized) return false;

    try {
      const stat = await Deno.lstat(this.rootPath);
      return stat.isDirectory;
    } catch {
      return false;
    }
  }

  // ===== Transaction Support =====

  async beginTransaction(): Promise<Transaction> {
    return NO_OP_TRANSACTION;
  }

  // ===== Helper: Convert FileInfo to Node =====

  private async fileInfoToNode<T extends NodeAttrs = NodeAttrs>(
    stat: Deno.FileInfo,
    absolutePath: string,
    relativePath: string,
  ): Promise<Node<T>> {
    const id = encodeId(relativePath);

    // Determine node type
    let type: NodeType;
    if (stat.isSymlink) {
      type = NODE_TYPE_SOFTLINK;
    } else if (stat.isDirectory) {
      type = NODE_TYPE_DIRECTORY;
    } else {
      type = NODE_TYPE_FILE;
    }

    const softlink = stat.isSymlink ? await readSoftlink(absolutePath) : undefined;

    // Build attrs based on type
    const attrs: NodeAttrs = {};
    if (type === NODE_TYPE_FILE) {
      attrs.name = basename(absolutePath);
      attrs.size = stat.size;
      attrs.mimetype = await getMimeFromExt(absolutePath);
      if (attrs.mimetype === MIME_DEFAULT_TYPE && stat.size > 0) {
        // No known extension: sniff content (magic bytes + text heuristic)
        try {
          const file = await Deno.open(absolutePath, { read: true });
          try {
            const buf = new Uint8Array(MIME_SAMPLE_BYTES);
            const n = await file.read(buf);
            if (n) {
              attrs.mimetype = await getMimeFromBuffer(buf.subarray(0, n));
            }
          } finally {
            file.close();
          }
        } catch {
          // unreadable: keep the default type
        }
      }
    }

    const node: Node<T> = {
      id,
      type,
      props: {
        ...pathProps(stat, softlink),
        birthtime: {
          uid: stat.uid ?? 0,
          timestamp: stat.birthtime?.getTime() ?? Date.now(),
        },
        changetime: {
          uid: stat.uid ?? 0,
          timestamp: stat.atime?.getTime() ?? Date.now(),
        },
        modtime: {
          uid: stat.uid ?? 0,
          timestamp: stat.mtime?.getTime() ?? Date.now(),
        },
        count: stat.isFile ? (stat.nlink || 0) : 1,
      },
      attrs: attrs as T,
    };

    return node;
  }

  // ===== Helper: Find path by ID =====

  private async findPathById(id: NodeId): Promise<WalkEntry> {
    const relativePath = decodeId(id);
    if (relativePath === null) {
      throw new NodeNotFoundError(id);
    }

    const absolutePath = relativePath ? join(this.rootPath, relativePath) : this.rootPath;

    // Security check
    this.assertPathWithinRoot(absolutePath);

    try {
      const stat = await Deno.lstat(absolutePath);
      return { absolutePath, relativePath, stat };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NodeNotFoundError(id);
      }
      throw error;
    }
  }

  // ===== Helper: Security check =====

  private assertPathWithinRoot(absolutePath: string): void {
    const normalizedPath = normalize(absolutePath);
    const normalizedRoot = normalize(this.rootPath);

    if (!normalizedPath.startsWith(normalizedRoot)) {
      throw new Error('Path traversal detected');
    }
  }

  // ===== Core Read Operations =====

  async getNode<T extends NodeAttrs = NodeAttrs>(id: NodeId): Promise<Node<T>> {
    const entry = await this.findPathById(id);
    return await this.fileInfoToNode<T>(entry.stat, entry.absolutePath, entry.relativePath);
  }

  /**
   * Walk `segments` down from `fromId` with one `lstat` per level, all issued at once rather than
   * one `getChildren` after another. The chain ends at the first name that is missing, that is
   * not a plain entry name, or whose parent is not a directory — a softlink among them, as `lstat`
   * does not follow it. The VFS follows a softlink by its own rules, so whatever the host's
   * `lstat` found past one is not used.
   */
  async resolveChain(fromId: NodeId, segments: string[]): Promise<ResolvedNodeChain> {
    const base = decodeId(fromId);
    if (base === null) {
      throw new NodeNotFoundError(fromId);
    }

    const invalid = segments.findIndex((name) => !isEntryName(name));
    const names = invalid === -1 ? segments : segments.slice(0, invalid);
    const paths = names.map((_, i) => join(base, ...names.slice(0, i + 1)));
    const [root, ...stats] = await Promise.all([this.findPathById(fromId), ...paths.map((path) => this.lstatWithinRoot(path))]);

    const entries: PathEntry[] = [];
    let parent = root.stat;
    for (const [i, stat] of stats.entries()) {
      if (!stat || !parent.isDirectory) break;
      const softlink = stat.isSymlink ? await readSoftlink(join(this.rootPath, paths[i])) : undefined;
      entries.push({ id: encodeId(paths[i]), name: names[i], props: pathProps(stat, softlink) });
      parent = stat;
    }

    return { root: { id: fromId, props: pathProps(root.stat) }, entries };
  }

  /**
   * The `lstat` of a path relative to the root, or undefined when it fails for any reason; the
   * VFS looks such a level up on its own.
   */
  private async lstatWithinRoot(relativePath: string): Promise<Deno.FileInfo | undefined> {
    const absolutePath = join(this.rootPath, relativePath);
    this.assertPathWithinRoot(absolutePath);
    try {
      return await Deno.lstat(absolutePath);
    } catch {
      return undefined;
    }
  }

  /**
   * A listing of one directory is one `readDir`. `childCount` costs another per
   * subdirectory, so it is counted for a real listing only; a lookup by name or
   * id (every level of a path resolution) reports 0 rather than pay for it, since
   * a directory of thousands of entries would otherwise be read in full at every
   * resolution through it.
   */
  async getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    _tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]> {
    const parent = await this.findPathById(parentId);
    const lookup = opts?.name !== undefined || opts?.childId !== undefined;
    const entries: NodeChildEntry<T>[] = [];

    for (const link of await this.getChildLinks(parentId, opts)) {
      const childPath = join(parent.absolutePath, link.name);

      try {
        const childStat = await Deno.lstat(childPath);
        entries.push({
          node: await this.fileInfoToNode<T>(childStat, childPath, relative(this.rootPath, childPath)),
          name: link.name,
          position: link.position,
          childCount: !lookup && childStat.isDirectory ? await this.countChildren(link.id) : 0,
        });
      } catch {
        // Skip children we can't access
      }
    }

    return pageChildEntries(entries, opts);
  }

  /**
   * The directory itself is the hierarchy here, so an edge is a `readDir`
   * entry. Ids stay derived from the relative path (`encodeId`).
   */
  async getChildLinks(parentId: NodeId, opts?: ChildLinkFilter, _tx?: Transaction): Promise<NodeChild[]> {
    const parent = await this.findPathById(parentId);

    if (!parent.stat.isDirectory) {
      return [];
    }

    // A lookup by name or id is one lstat, not a listing
    if (opts?.name !== undefined || opts?.childId !== undefined) {
      // By id, the name is the last segment; comparing the ids below confirms the parent
      const childPath = opts.childId !== undefined ? decodeId(opts.childId) : null;
      const name = opts.name ?? (childPath !== null ? basename(childPath) : undefined);
      if (name === undefined || !isEntryName(name)) return [];

      const childRelativePath = parent.relativePath ? join(parent.relativePath, name) : name;
      const id = encodeId(childRelativePath);
      if (opts.childId !== undefined && opts.childId !== id) return [];

      try {
        await Deno.lstat(join(parent.absolutePath, name));
      } catch {
        return [];
      }
      return [{ id, name }];
    }

    const links: NodeChild[] = [];

    try {
      let position = 0;
      for await (const entry of Deno.readDir(parent.absolutePath)) {
        position++;
        if (opts?.name !== undefined && entry.name !== opts.name) continue;

        const childRelativePath = parent.relativePath ? join(parent.relativePath, entry.name) : entry.name;
        const id = encodeId(childRelativePath);
        if (opts?.childId !== undefined && id !== opts.childId) continue;

        links.push({ id, name: entry.name, position });
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NodeNotFoundError(parentId);
      }
      // Permission denied and the like: nothing readable here
      return [];
    }

    return links;
  }

  async countChildren(parentId: NodeId, _tx?: Transaction): Promise<number> {
    return (await this.getChildLinks(parentId)).length;
  }

  /** One `lstat` per id; an id that does not decode or is not there is absent. */
  async getOwnership(ids: NodeId[], _tx?: Transaction): Promise<Map<NodeId, Ownership>> {
    const result = new Map<NodeId, Ownership>();
    await Promise.all([...new Set(ids)].map(async (id) => {
      const relativePath = decodeId(id);
      if (relativePath === null) return;
      const stat = await this.lstatWithinRoot(relativePath).catch(() => undefined);
      if (stat) result.set(id, pathProps(stat));
    }));
    return result;
  }

  async getParents<T extends NodeAttrs = NodeAttrs>(_childId: NodeId, _tx?: Transaction): Promise<Node<T>[]> {
    throw new Error('getParents is not implemented yet on the filesystem store');
  }

  async exists(id: NodeId, _tx?: Transaction): Promise<boolean> {
    const relativePath = decodeId(id);
    if (relativePath === null) {
      return false;
    }

    const absolutePath = relativePath ? join(this.rootPath, relativePath) : this.rootPath;

    try {
      this.assertPathWithinRoot(absolutePath);
      await Deno.lstat(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  // ===== Write Operations =====

  async createNode<T extends NodeAttrs = NodeAttrs>(
    _uid: UserId,
    type: NodeType,
    parentId: NodeId,
    name: string,
    props: NodePropsCreate,
    _attrs?: T,
  ): Promise<Node<T>> {
    // Find parent directory
    const parent = await this.findPathById(parentId);

    if (!parent.stat.isDirectory) {
      throw new Error('Parent is not a directory');
    }

    const newPath = join(parent.absolutePath, name);
    this.assertPathWithinRoot(newPath);

    // Check if already exists
    try {
      await Deno.lstat(newPath);
      throw new NodeAlreadyExistsError(parentId, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Create based on type
    switch (type) {
      case 'directory':
        await Deno.mkdir(newPath, { mode: props.mode ?? 0o755 });
        break;

      case NODE_TYPE_FILE:
        await Deno.writeFile(newPath, new Uint8Array(), { mode: props.mode ?? 0o644 });
        break;

      case 'softlink': {
        const target = props.softlink;
        if (!target) {
          throw new Error('Softlink requires a target path in props.softlink');
        }
        await Deno.symlink(target, newPath);
        break;
      }

      default:
        throw new Error(`Unsupported node type for filesystem: ${type}`);
    }

    // Set permissions if specified (already done via mode in mkdir/writeFile, but chmod ensures)
    if (props.mode !== undefined && type !== 'softlink') {
      try {
        await Deno.chmod(newPath, props.mode);
      } catch {
        // Ignore permission errors
      }
    }

    // Return the created node
    const stat = await Deno.lstat(newPath);
    const relativePath = relative(this.rootPath, newPath);
    return await this.fileInfoToNode<T>(stat, newPath, relativePath);
  }

  async updateNode<T extends NodeAttrs = NodeAttrs>(
    _uid: UserId,
    id: NodeId,
    props?: NodePropsUpdate,
    _attrs?: NodeAttrsUpdate<T>,
  ): Promise<Node<T>> {
    const entry = await this.findPathById(id);

    // Update mode (permissions)
    if (props?.mode !== undefined && !entry.stat.isSymlink) {
      try {
        await Deno.chmod(entry.absolutePath, props.mode);
      } catch {
        // May fail without elevated permissions
      }
    }

    // Update symlink target
    if (props?.softlink !== undefined && entry.stat.isSymlink) {
      // Remove old symlink and create new one
      await Deno.remove(entry.absolutePath);
      await Deno.symlink(props.softlink, entry.absolutePath);
    }

    // Return updated node
    const stat = await Deno.lstat(entry.absolutePath);
    return await this.fileInfoToNode<T>(stat, entry.absolutePath, entry.relativePath);
  }

  // ===== Hierarchy Writes =====
  //
  // The directory *is* the hierarchy, so createNode/deleteNode have already
  // made the edge exist or not. These only have to agree with the filesystem.

  /**
   * Nothing to do when the entry under `name` already is the node being linked.
   * A second name for an existing node would be a hard link, which this store
   * does not do — say so rather than silently no-op.
   */
  async linkChild(
    _uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
  ): Promise<void> {
    const parent = await this.findPathById(parentId);
    const childPath = join(parent.absolutePath, name);

    this.assertPathWithinRoot(childPath);

    const existing = encodeId(relative(this.rootPath, childPath));
    if (existing === childId) {
      return;
    }

    throw new Error(`hard links are not supported on the filesystem store: ${name}`);
  }

  /** `deleteNode` removes the entry; an unlink that keeps the node is a no-op. */
  async unlinkChild(): Promise<void> {}

  async moveChild(
    _uid: UserId,
    oldParentId: NodeId,
    oldName: string,
    newParentId: NodeId,
    newName: string,
  ): Promise<void> {
    const oldParent = await this.findPathById(oldParentId);
    const newParent = await this.findPathById(newParentId);

    const oldPath = join(oldParent.absolutePath, oldName);
    const newPath = join(newParent.absolutePath, newName);

    this.assertPathWithinRoot(oldPath);
    this.assertPathWithinRoot(newPath);

    try {
      await Deno.rename(oldPath, newPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NodeNotFoundError(`${oldName} in ${oldParentId}`);
      }
      throw error;
    }
  }

  async deleteNode(
    _uid: UserId,
    id: NodeId,
  ): Promise<boolean> {
    const entry = await this.findPathById(id);

    // Don't allow deleting the root
    if (entry.absolutePath === this.rootPath) {
      throw new Error('Cannot delete root directory');
    }

    try {
      await Deno.remove(entry.absolutePath);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }
}

/** A name one directory entry can have: not empty, not `.` or `..`, and holding no `/`. */
const isEntryName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !name.includes('/');

/** A softlink's target, or undefined when it cannot be read. */
async function readSoftlink(absolutePath: string): Promise<string | undefined> {
  try {
    return await Deno.readLink(absolutePath);
  } catch {
    return undefined;
  }
}

/** What a path walk checks of an entry: its mode and owner, and where it leads if it is a softlink. */
function pathProps(stat: Deno.FileInfo, softlink?: string): PathNode['props'] {
  return {
    mode: stat.mode ?? 0o644,
    uid: stat.uid ?? 0,
    gid: stat.gid ?? 0,
    ...(softlink ? { softlink } : {}),
  };
}
