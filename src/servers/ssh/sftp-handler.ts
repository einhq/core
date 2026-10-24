/**
 * SFTP Handler
 *
 * Maps SFTP protocol operations to VFS operations.
 *
 * A file's own children (EXIF, faces, thumbnails …) are reached through its
 * shadow directory: `file.jpg_/` lists what belongs to `file.jpg`. Shadows are
 * read-only and never listed, so `cp -r` and rsync copy files without them,
 * but they can be entered by name at any depth.
 *
 * Softlinks are SFTP symlinks: listings and LSTAT report them as S_IFLNK,
 * SYMLINK creates one, and REMOVE deletes the link, never its target.
 */

import { basename, dirname, join, resolve } from '@std/path';
import { OPEN_MODE, type SFTP, STATUS_CODE } from 'ssh2';
import type { Access } from '../../lib/access/mod.ts';
import { getMimeFromBuffer, getMimeFromExt, MIME_SAMPLE_BYTES } from '../../lib/media/mime.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import { type ResourceMode, ResourceSeekMode } from '../../registries/types.ts';
import type { Node, NodeVFS } from '../../vfs/mod.ts';
import { NodeNotFoundError } from '../../vfs/mod.ts';
import { NODE_TYPE_EMBEDDING } from '../../vfs/types/embedding.ts';
import { contentTime, NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { NODE_TYPE_LOG } from '../../vfs/types/log.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';

const logger = createLogger('sftp-handler');

// Shadow directory suffix for files with children
const SHADOW_SUFFIX = '_';

// OpenSSH accepts SFTP packets up to 256 KiB. Leave the same 2 KiB allowance
// as ssh2-ts uses for packet framing when an OpenSSH client asks for a full
// 256 KiB read buffer.
const MAX_SFTP_READ_DATA = 256 * 1024 - 2 * 1024;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const FILE_TYPES = [
  NODE_TYPE_FILE,
  NODE_TYPE_EMBEDDING,
  NODE_TYPE_LOG,
];

export type SFTPHandlerConfig = {
  vfs: NodeVFS;
  access: Access;
  homePath: string;
};

type HandleEntry = {
  handle: ResourceHandleIf;
  path: string;
  position?: number;
  append?: boolean;
  dirty?: boolean;
  /** A client-set modification time, applied after close stamps its own. */
  writtenAt?: string;
};

type ResolvedPath = {
  /** The path as the client names it, normalized; shadow segments kept. */
  clientPath: string;
  /** The node it names: every shadow segment replaced by its file. */
  vfsPath: string;
  /** The path names a shadow directory itself. */
  isShadow: boolean;
  /** The path is a shadow directory or lies inside one. */
  inShadow: boolean;
};

type DirEntry = {
  path: string;
  entries: Array<{ name: string; attrs: Record<string, unknown> }>;
  index: number;
};

export class SFTPHandler {
  private handles = new Map<number, HandleEntry>();
  private dirHandles = new Map<number, DirEntry>();
  private nextHandle = 1;

  // Path-based locking to serialize concurrent operations on the same path
  private pathLocks = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();

  // Track if the SFTP stream is closed to avoid sending responses on closed streams
  private closed = false;

  // Resource handles are cursor-based, so seek/read/write/close calls for one
  // handle must retain request order. Different handles can run independently;
  // ssh2-ts orders the resulting channel packets itself.
  private handleOperations = new Map<number, Promise<void>>();

  constructor(private config: SFTPHandlerConfig) {}

  private cleanupHandles(): void {
    for (const [handleId, entry] of this.handles) {
      try {
        entry.handle.close();
      } catch (err) {
        logger.debug('error closing handle on cleanup', {
          handleId,
          path: entry.path,
          error: (err as Error).message,
        });
      }
    }
    this.handles.clear();
    this.dirHandles.clear();
  }

  private enqueueRequest(handler: () => Promise<void>, handleId?: number): void {
    const run = async () => {
      if (this.closed) return;
      try {
        await handler();
      } catch (err) {
        logger.error('SFTP request handler error', {
          error: (err as Error).message,
        });
      }
    };

    if (handleId === undefined) {
      void run();
      return;
    }

    const previous = this.handleOperations.get(handleId) ?? Promise.resolve();
    const current = previous.then(run);
    this.handleOperations.set(handleId, current);
    void current.then(() => {
      if (this.handleOperations.get(handleId) === current) {
        this.handleOperations.delete(handleId);
      }
    });
  }

  private enqueueHandleRequest(
    handleBuf: Uint8Array,
    handler: (handle: Uint8Array) => Promise<void>,
  ): void {
    const handle = new Uint8Array(handleBuf);
    let handleId: number | undefined;
    try {
      handleId = this.bufferToHandle(handle);
    } catch {
      // Let the request handler return the protocol-level invalid handle error.
    }
    this.enqueueRequest(() => handler(handle), handleId);
  }

  private sendResponse(fn: () => void): void {
    if (!this.closed) {
      fn();
    }
  }

  private async acquirePathLock(path: string): Promise<() => void> {
    while (this.pathLocks.has(path)) {
      await this.pathLocks.get(path)!.promise;
    }

    let resolveFunc: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveFunc = resolve;
    });
    this.pathLocks.set(path, { promise, resolve: resolveFunc! });

    return () => {
      const lock = this.pathLocks.get(path);
      if (lock && lock.promise === promise) {
        this.pathLocks.delete(path);
        lock.resolve();
      }
    };
  }

  private async waitForPathLock(path: string): Promise<void> {
    while (this.pathLocks.has(path)) {
      await this.pathLocks.get(path)!.promise;
    }
  }

  attach(sftp: SFTP): void {
    sftp.on('close', () => {
      this.closed = true;
      this.cleanupHandles();
    });
    sftp.on('end', () => {
      this.closed = true;
      this.cleanupHandles();
    });
    sftp.on('error', (err: Error) => {
      logger.error('SFTP stream error', { error: err.message });
      this.closed = true;
      this.cleanupHandles();
    });

    sftp.on('OPEN', this.handleOpen.bind(this, sftp));
    sftp.on('READ', this.handleRead.bind(this, sftp));
    sftp.on('WRITE', this.handleWrite.bind(this, sftp));
    sftp.on('CLOSE', this.handleClose.bind(this, sftp));
    sftp.on('FSTAT', this.handleFstat.bind(this, sftp));
    sftp.on('STAT', this.handleStat.bind(this, sftp));
    sftp.on('LSTAT', this.handleLstat.bind(this, sftp));
    sftp.on('READLINK', this.handleReadlink.bind(this, sftp));
    sftp.on('OPENDIR', this.handleOpendir.bind(this, sftp));
    sftp.on('READDIR', this.handleReaddir.bind(this, sftp));
    sftp.on('REALPATH', this.handleRealpath.bind(this, sftp));
    sftp.on('MKDIR', this.handleMkdir.bind(this, sftp));
    sftp.on('RMDIR', this.handleRmdir.bind(this, sftp));
    sftp.on('REMOVE', this.handleRemove.bind(this, sftp));
    sftp.on('RENAME', this.handleRename.bind(this, sftp));
    sftp.on('SETSTAT', this.handleSetstat.bind(this, sftp));
    sftp.on('FSETSTAT', this.handleFsetstat.bind(this, sftp));
    sftp.on('SYMLINK', this.handleSymlink.bind(this, sftp));
  }

  private isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Resolve a client path. A segment `name_` is the shadow of `name` when
   * `name` is a file and no real node is called `name_`; only segments ending
   * in the suffix cost a lookup.
   */
  private async resolvePath(path: string): Promise<ResolvedPath> {
    const clientPath = resolve(this.config.homePath, path);
    let vfsPath = '/';
    let isShadow = false;
    let inShadow = false;

    for (const segment of clientPath.split('/').filter(Boolean)) {
      isShadow = segment.length > SHADOW_SUFFIX.length && segment.endsWith(SHADOW_SUFFIX) &&
        await this.isShadowSegment(vfsPath, segment);
      inShadow ||= isShadow;
      vfsPath = join(vfsPath, isShadow ? segment.slice(0, -SHADOW_SUFFIX.length) : segment);
    }

    return { clientPath, vfsPath, isShadow, inShadow };
  }

  private async isShadowSegment(parentPath: string, segment: string): Promise<boolean> {
    const { vfs, access } = this.config;
    if (await vfs.exists(access, join(parentPath, segment), { follow: false })) {
      return false;
    }
    try {
      const node = await vfs.get(access, join(parentPath, segment.slice(0, -SHADOW_SUFFIX.length)));
      return FILE_TYPES.includes(node.type);
    } catch (err) {
      if (err instanceof NodeNotFoundError) return false;
      throw err;
    }
  }

  /** Shadow directories and everything in them are read-only. */
  private refuseInShadow(sftp: SFTP, reqid: number, resolved: ResolvedPath): boolean {
    if (!resolved.inShadow) return false;
    this.sendResponse(() => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'shadow directories are read-only'));
    return true;
  }

  private nodeToAttrs(
    node: Node,
  ): { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number } {
    // A node read without following links is the link itself; a listing
    // reports it as one (lstat semantics, as OpenSSH does) so clients copy
    // the link instead of descending into its target.
    const fileType = node.props.softlink ? S_IFLNK : FILE_TYPES.includes(node.type) ? S_IFREG : S_IFDIR;
    const unixTime = Math.floor(contentTime(node) / 1000);

    return {
      mode: fileType | (node.props.mode & 0o7777),
      uid: node.props.uid,
      gid: node.props.gid,
      size: (node.attrs as Record<string, unknown>)?.size as number || 0,
      atime: unixTime,
      mtime: unixTime,
    };
  }

  /** A shadow directory: the file's own times and owner, as a directory. */
  private shadowAttrs(node: Node) {
    return { ...this.nodeToAttrs(node), mode: S_IFDIR | 0o755, size: 0 };
  }

  private handleToBuffer(handleId: number): Uint8Array {
    const buf = new Uint8Array(4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, handleId, false);
    return buf;
  }

  private bufferToHandle(buf: Uint8Array): number {
    const view = new DataView(
      buf.buffer,
      buf.byteOffset,
      Math.min(buf.byteLength, 4),
    );
    return view.getUint32(0, false);
  }

  // ---- OPEN ----

  private handleOpen(
    sftp: SFTP,
    reqid: number,
    filename: string,
    flags: number,
    _attrs: unknown,
  ): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleOpen(sftp, reqid, filename, flags);
      } catch (err) {
        logger.error('SFTP OPEN error', {
          filename,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleOpen(
    sftp: SFTP,
    reqid: number,
    filename: string,
    flags: number,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(filename);
    const { vfsPath } = resolved;

    if (resolved.isShadow) {
      this.sendResponse(() =>
        sftp.status(
          reqid,
          STATUS_CODE.FAILURE,
          'cannot open shadow directory as file',
        )
      );
      return;
    }
    if ((flags & (OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) && this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }

    let mode: ResourceMode = 'r';
    if (flags & OPEN_MODE.WRITE) {
      if (flags & OPEN_MODE.TRUNC) {
        mode = 'w';
      } else if (flags & OPEN_MODE.APPEND) {
        mode = 'a';
      } else {
        mode = 'r+';
      }
    }

    const needsLock = !!(flags & OPEN_MODE.CREAT);
    const releaseLock = needsLock ? await this.acquirePathLock(vfsPath) : null;

    try {
      if (flags & OPEN_MODE.CREAT) {
        const exists = await this.config.vfs.exists(
          this.config.access,
          vfsPath,
        );
        if (!exists) {
          await this.config.vfs.create(
            this.config.access,
            NODE_TYPE_FILE,
            dirname(vfsPath),
            basename(vfsPath),
            {
              attrs: {
                name: basename(vfsPath),
                mimetype: await getMimeFromExt(basename(vfsPath)),
                size: 0,
              },
            },
          );
        }
      }

      const handle = await this.config.vfs.open(this.config.access, vfsPath, {
        mode,
      });
      const handleId = this.nextHandle++;
      this.handles.set(handleId, {
        handle,
        path: vfsPath,
        position: mode === 'a' ? undefined : 0,
        append: mode === 'a',
      });

      this.sendResponse(() => sftp.handle(reqid, this.handleToBuffer(handleId)));
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    } finally {
      releaseLock?.();
    }
  }

  // ---- READ ----

  private handleRead(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    offset: number | bigint,
    length: number,
  ): void {
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleRead(sftp, reqid, handle, offset, length);
      } catch (err) {
        logger.error('SFTP READ error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleRead(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    offset: number | bigint,
    length: number,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const handleId = this.bufferToHandle(handleBuf);
    const entry = this.handles.get(handleId);
    if (!entry) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
      return;
    }

    const readOffset = Number(offset);
    if (entry.position !== readOffset) {
      entry.position = await entry.handle.seek(readOffset, ResourceSeekMode.Start);
    }
    const data = await entry.handle.read(Math.min(length, MAX_SFTP_READ_DATA));
    entry.position = readOffset + data.length;

    if (data.length === 0) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.EOF));
    } else {
      this.sendResponse(() => sftp.data(reqid, data));
    }
  }

  // ---- WRITE ----

  private handleWrite(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    offset: number | bigint,
    data: Uint8Array,
  ): void {
    const writeData = new Uint8Array(data);
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleWrite(
          sftp,
          reqid,
          handle,
          offset,
          writeData,
        );
      } catch (err) {
        logger.error('SFTP WRITE error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleWrite(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    offset: number | bigint,
    data: Uint8Array,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const handleId = this.bufferToHandle(handleBuf);
    const entry = this.handles.get(handleId);
    if (!entry) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
      return;
    }

    const writeOffset = Number(offset);
    if (entry.append || entry.position !== writeOffset) {
      entry.position = await entry.handle.seek(writeOffset, ResourceSeekMode.Start);
    }
    const bytesWritten = await entry.handle.write(data);
    if (!entry.append) entry.position = writeOffset + bytesWritten;
    entry.dirty = true;

    if (bytesWritten !== data.length) {
      logger.warn('partial write', {
        path: entry.path,
        expected: data.length,
        actual: bytesWritten,
        offset: Number(offset),
      });
      this.sendResponse(() =>
        sftp.status(
          reqid,
          STATUS_CODE.FAILURE,
          `partial write: ${bytesWritten}/${data.length} bytes`,
        )
      );
      return;
    }

    this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
  }

  // ---- CLOSE ----

  private handleClose(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): void {
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleClose(sftp, reqid, handle);
      } catch (err) {
        logger.error('SFTP CLOSE error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleClose(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): Promise<void> {
    const handleId = this.bufferToHandle(handleBuf);

    const fileEntry = this.handles.get(handleId);
    if (fileEntry) {
      await fileEntry.handle.close();
      this.handles.delete(handleId);

      if (fileEntry.dirty || fileEntry.writtenAt) {
        // Closing the write handle stored size and sha256. The mimetype is
        // sniffed from the content, as an HTTP upload does, so a file whose
        // name says one type and whose bytes say another is filed by its bytes.
        try {
          const attrs: Record<string, unknown> = {};
          if (fileEntry.dirty) {
            attrs.mimetype = await this.sniffMimetype(fileEntry.path);
          }
          if (fileEntry.writtenAt) {
            attrs.writtenAt = fileEntry.writtenAt;
          }
          await this.config.vfs.update(this.config.access, fileEntry.path, {
            attrs,
          });
        } catch (err) {
          logger.debug('could not update file attrs on close', {
            path: fileEntry.path,
            error: (err as Error).message,
          });
        }
      }

      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
      return;
    }

    if (this.dirHandles.has(handleId)) {
      this.dirHandles.delete(handleId);
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
      return;
    }

    this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
  }

  /** The mimetype the head of the file at path sniffs as, a camera RAW or a sidecar told by its name. */
  private async sniffMimetype(path: string): Promise<string> {
    const handle = await this.config.vfs.open(this.config.access, path, { mode: 'r' });
    try {
      return await getMimeFromBuffer(await handle.read(MIME_SAMPLE_BYTES), path);
    } finally {
      await handle.close();
    }
  }

  // ---- STAT ----

  private handleStat(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleStat(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP STAT error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleStat(
    sftp: SFTP,
    reqid: number,
    path: string,
    resolveOpts?: { readlink?: boolean },
  ): Promise<void> {
    if (!this.isOpen()) return;

    const { vfsPath, isShadow } = await this.resolvePath(path);

    await this.waitForPathLock(vfsPath);
    if (!this.isOpen()) return;

    try {
      const node = await this.config.vfs.get(this.config.access, vfsPath, resolveOpts);

      if (isShadow) {
        if (await this.config.vfs.childCount(this.config.access, vfsPath, resolveOpts) === 0) {
          this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
          return;
        }
        this.sendResponse(() => sftp.attrs(reqid, this.shadowAttrs(node)));
      } else {
        this.sendResponse(() => sftp.attrs(reqid, this.nodeToAttrs(node)));
      }
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    }
  }

  // ---- LSTAT ----

  private handleLstat(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleStat(sftp, reqid, path, { readlink: true });
      } catch (err) {
        logger.error('SFTP LSTAT error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  // ---- READLINK ----

  private handleReadlink(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        const { vfsPath } = await this.resolvePath(path);

        await this.waitForPathLock(vfsPath);
        if (!this.isOpen()) return;

        const node = await this.config.vfs.get(this.config.access, vfsPath, { readlink: true });

        if (!node.props.softlink) {
          this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'not a symlink'));
          return;
        }

        const target = node.props.softlink!;
        this.sendResponse(() => sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]));
      } catch (err) {
        if (err instanceof NodeNotFoundError) {
          this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        } else {
          logger.error('SFTP READLINK error', { path, error: (err as Error).message });
          this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
        }
      }
    });
  }

  // ---- FSTAT ----

  private handleFstat(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): void {
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleFstat(sftp, reqid, handle);
      } catch (err) {
        logger.error('SFTP FSTAT error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleFstat(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const handleId = this.bufferToHandle(handleBuf);
    const entry = this.handles.get(handleId);

    if (!entry) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
      return;
    }

    await this.waitForPathLock(entry.path);
    if (!this.isOpen()) return;

    // The node carries mode, owner and times; the handle the size, which runs
    // ahead of the node's while a write is in progress.
    const node = await this.config.vfs.get(this.config.access, entry.path);
    const stats = await entry.handle.stat() as { size: number };
    this.sendResponse(() => sftp.attrs(reqid, { ...this.nodeToAttrs(node), size: stats.size }));
  }

  // ---- OPENDIR ----

  private handleOpendir(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleOpendir(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP OPENDIR error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleOpendir(
    sftp: SFTP,
    reqid: number,
    path: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const { vfsPath, isShadow } = await this.resolvePath(path);

    await this.waitForPathLock(vfsPath);
    if (!this.isOpen()) return;

    try {
      const node = await this.config.vfs.get(this.config.access, vfsPath);

      // A file's children are listed through its shadow, never through the
      // file itself, which would make it a file and a directory at once.
      if (FILE_TYPES.includes(node.type) && !isShadow) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'not a directory'));
        return;
      }

      const children = await this.config.vfs.children(this.config.access, vfsPath);
      if (isShadow && children.length === 0) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
        return;
      }

      const self = isShadow ? this.shadowAttrs(node) : this.nodeToAttrs(node);
      const entries: Array<{ name: string; attrs: Record<string, unknown> }> = [
        { name: '.', attrs: self },
        { name: '..', attrs: self },
      ];

      // Shadows are not listed: `cp -r` and rsync would copy every file's
      // thumbnails and metadata with it. They are reachable by name.
      for (const child of children) {
        entries.push({
          name: child.name,
          attrs: this.nodeToAttrs(child.node),
        });
      }

      const handleId = this.nextHandle++;
      this.dirHandles.set(handleId, { path: vfsPath, entries, index: 0 });

      this.sendResponse(() => sftp.handle(reqid, this.handleToBuffer(handleId)));
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    }
  }

  // ---- READDIR ----

  private handleReaddir(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): void {
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleReaddir(sftp, reqid, handle);
      } catch (err) {
        logger.error('SFTP READDIR error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleReaddir(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const handleId = this.bufferToHandle(handleBuf);
    const entry = this.dirHandles.get(handleId);

    if (!entry) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
      return;
    }

    if (entry.index >= entry.entries.length) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.EOF));
      return;
    }

    const batch = entry.entries.slice(entry.index, entry.index + 100);
    entry.index += batch.length;

    const names = batch.map((e) => ({
      filename: e.name,
      longname: this.formatLongname(e.name, e.attrs),
      attrs: e.attrs,
    }));

    this.sendResponse(() => sftp.name(reqid, names));
  }

  private formatLongname(
    name: string,
    attrs: Record<string, unknown>,
  ): string {
    const mode = attrs.mode as number;
    const typeChar = (mode & S_IFMT) === S_IFDIR ? 'd' : (mode & S_IFMT) === S_IFLNK ? 'l' : '-';
    const perms = this.formatPerms(mode);
    const mtime = attrs.mtime as number;
    const date = new Date(mtime * 1000);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    });

    return `${typeChar}${perms}   1 ${attrs.uid} ${attrs.gid} ${attrs.size || 0} ${dateStr} ${name}`;
  }

  private formatPerms(mode: number): string {
    const perms = mode & 0o777;
    let str = '';
    for (let i = 2; i >= 0; i--) {
      const bits = (perms >> (i * 3)) & 0o7;
      str += (bits & 0o4) ? 'r' : '-';
      str += (bits & 0o2) ? 'w' : '-';
      str += (bits & 0o1) ? 'x' : '-';
    }
    return str;
  }

  // ---- REALPATH ----

  private handleRealpath(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleRealpath(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP REALPATH error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleRealpath(
    sftp: SFTP,
    reqid: number,
    path: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const { clientPath, vfsPath } = await this.resolvePath(path);

    if (path === '.' || path === '') {
      this.sendResponse(() =>
        sftp.name(reqid, [{
          filename: this.config.homePath,
          longname: this.config.homePath,
          attrs: {},
        }])
      );
      return;
    }

    await this.waitForPathLock(vfsPath);
    if (!this.isOpen()) return;

    try {
      // Answer with the client's own form of the path: a shadow segment must
      // survive, or `cd file.jpg_` would land on the file and be refused.
      // A missing last segment under a parent that exists resolves too, as
      // OpenSSH's sftp-server does: `scp -r dir host:/existing/` asks for the
      // path of the directory it is about to create.
      try {
        await this.config.vfs.get(this.config.access, vfsPath);
      } catch (err) {
        if (!(err instanceof NodeNotFoundError) || vfsPath === '/') throw err;
        await this.config.vfs.get(this.config.access, dirname(vfsPath));
      }
      this.sendResponse(() =>
        sftp.name(reqid, [{
          filename: clientPath,
          longname: clientPath,
          attrs: {},
        }])
      );
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    }
  }

  // ---- MKDIR ----

  private handleMkdir(
    sftp: SFTP,
    reqid: number,
    path: string,
    _attrs: unknown,
  ): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleMkdir(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP MKDIR error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleMkdir(
    sftp: SFTP,
    reqid: number,
    path: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(path);
    const { vfsPath } = resolved;

    if (this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }

    const releaseLock = await this.acquirePathLock(vfsPath);
    try {
      await this.config.vfs.create(
        this.config.access,
        'directory',
        dirname(vfsPath),
        basename(vfsPath),
      );
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
    } finally {
      releaseLock();
    }
  }

  // ---- RMDIR ----

  private handleRmdir(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleRmdir(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP RMDIR error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleRmdir(
    sftp: SFTP,
    reqid: number,
    path: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(path);
    const { vfsPath } = resolved;

    if (this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }

    const releaseLock = await this.acquirePathLock(vfsPath);
    try {
      // rmdir on a symlink fails, as it does in POSIX, rather than acting on
      // the directory it points to.
      const node = await this.config.vfs.get(this.config.access, vfsPath, { readlink: true });
      if (node.props.softlink) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'not a directory'));
        return;
      }

      const parentPath = dirname(vfsPath);
      await this.config.vfs.unlink(this.config.access, vfsPath, parentPath, { readlink: true });
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
    } finally {
      releaseLock();
    }
  }

  // ---- REMOVE ----

  private handleRemove(sftp: SFTP, reqid: number, path: string): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleRemove(sftp, reqid, path);
      } catch (err) {
        logger.error('SFTP REMOVE error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleRemove(
    sftp: SFTP,
    reqid: number,
    path: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(path);
    const { vfsPath } = resolved;

    if (this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }

    const releaseLock = await this.acquirePathLock(vfsPath);
    try {
      // Without readlink the path resolves to the link's target, and unlink
      // then deletes that node when this was its only name.
      const node = await this.config.vfs.get(this.config.access, vfsPath, { readlink: true });
      const isFile = FILE_TYPES.includes(node.type) && !node.props.softlink;
      if (!isFile && !node.props.softlink) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'is a directory'));
        return;
      }

      // A file goes with what belongs to it (metadata, thumbnails, faces), as
      // it does in the shell. The reap walks by id, so a link among them is
      // removed as a link, and a file with another name keeps its children.
      const parentPath = dirname(vfsPath);
      await this.config.vfs.unlink(this.config.access, vfsPath, parentPath, { readlink: true, recursive: isFile });
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    } finally {
      releaseLock();
    }
  }

  // ---- RENAME ----

  private handleRename(
    sftp: SFTP,
    reqid: number,
    oldPath: string,
    newPath: string,
  ): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleRename(sftp, reqid, oldPath, newPath);
      } catch (err) {
        logger.error('SFTP RENAME error', {
          oldPath,
          newPath,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleRename(
    sftp: SFTP,
    reqid: number,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const oldResolved = await this.resolvePath(oldPath);
    const newResolved = await this.resolvePath(newPath);
    const { vfsPath: oldVfsPath } = oldResolved;
    const { vfsPath: newVfsPath } = newResolved;

    if (this.refuseInShadow(sftp, reqid, oldResolved) || this.refuseInShadow(sftp, reqid, newResolved)) {
      return;
    }

    const paths = [oldVfsPath, newVfsPath].sort();
    const releaseLock1 = await this.acquirePathLock(paths[0]);
    const releaseLock2 = paths[0] !== paths[1] ? await this.acquirePathLock(paths[1]) : null;

    try {
      const oldParent = await this.config.vfs.get(
        this.config.access,
        dirname(oldVfsPath),
      );
      const newParent = await this.config.vfs.get(
        this.config.access,
        dirname(newVfsPath),
      );

      await this.config.vfs.rename(
        this.config.access,
        oldParent.id,
        basename(oldVfsPath),
        newParent.id,
        basename(newVfsPath),
      );

      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
    } finally {
      releaseLock2?.();
      releaseLock1();
    }
  }

  // ---- SETSTAT ----

  private handleSetstat(
    sftp: SFTP,
    reqid: number,
    path: string,
    attrs: Record<string, unknown>,
  ): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleSetstat(sftp, reqid, path, attrs);
      } catch (err) {
        logger.error('SFTP SETSTAT error', {
          path,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleSetstat(
    sftp: SFTP,
    reqid: number,
    path: string,
    attrs: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(path);
    const { vfsPath } = resolved;

    if (this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }

    await this.waitForPathLock(vfsPath);
    if (!this.isOpen()) return;

    const status = await this.applySetstat(vfsPath, attrs);
    this.sendResponse(() => sftp.status(reqid, status));
  }

  /**
   * The part of SETSTAT and FSETSTAT that changes the node, returning the
   * status to answer. Mode, owner and the modification time are applied (the
   * access time is not kept). A size is applied only when it needs no rewrite
   * of the content — unchanged, or 0 — and any other size is refused before
   * anything changes, rather than answered OK and dropped.
   */
  private async applySetstat(vfsPath: string, attrs: Record<string, unknown>, entry?: HandleEntry): Promise<number> {
    const { vfs, access } = this.config;

    if (attrs.size !== undefined) {
      const size = Number(attrs.size);
      const current = entry ? await entry.handle.size() : Number((await vfs.get(access, vfsPath)).attrs.size ?? 0);
      if (size !== current && size !== 0) {
        return STATUS_CODE.OP_UNSUPPORTED;
      }
      if (size !== current) {
        // Opening for writing truncates; its close reports the new size.
        const truncating = await vfs.open(access, vfsPath, { mode: 'w' });
        await truncating.close();
      }
    }

    if (attrs.mtime !== undefined) {
      const writtenAt = new Date(Number(attrs.mtime) * 1000).toISOString();
      // An open write handle stamps the time of its own close, so a time set
      // through it (`put -p`, `cp -p` over sshfs) waits for that close.
      if (entry && entry.handle.mode !== 'r') {
        entry.writtenAt = writtenAt;
      } else {
        await vfs.update(access, vfsPath, { attrs: { writtenAt } });
      }
    }

    const updates: Record<string, unknown> = {};

    if (attrs.mode !== undefined) {
      updates.mode = (attrs.mode as number) & 0o7777;
    }
    if (attrs.uid !== undefined) {
      updates.uid = attrs.uid;
    }
    if (attrs.gid !== undefined) {
      updates.gid = attrs.gid;
    }

    if (Object.keys(updates).length > 0) {
      await this.config.vfs.update(this.config.access, vfsPath, {
        props: updates,
      });
    }

    return STATUS_CODE.OK;
  }

  // ---- FSETSTAT ----

  private handleFsetstat(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    attrs: Record<string, unknown>,
  ): void {
    this.enqueueHandleRequest(handleBuf, async (handle) => {
      try {
        await this.doHandleFsetstat(sftp, reqid, handle, attrs);
      } catch (err) {
        logger.error('SFTP FSETSTAT error', { error: (err as Error).message });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleFsetstat(
    sftp: SFTP,
    reqid: number,
    handleBuf: Uint8Array,
    attrs: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const handleId = this.bufferToHandle(handleBuf);
    const entry = this.handles.get(handleId);

    if (!entry) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle'));
      return;
    }

    await this.waitForPathLock(entry.path);
    if (!this.isOpen()) return;

    const status = await this.applySetstat(entry.path, attrs, entry);
    this.sendResponse(() => sftp.status(reqid, status));
  }

  // ---- SYMLINK ----

  // ssh2-ts swaps OpenSSH's reversed argument order before emitting, so the
  // link path arrives first whichever client sent it.
  private handleSymlink(
    sftp: SFTP,
    reqid: number,
    linkPath: string,
    targetPath: string,
  ): void {
    this.enqueueRequest(async () => {
      try {
        await this.doHandleSymlink(sftp, reqid, linkPath, targetPath);
      } catch (err) {
        logger.error('SFTP SYMLINK error', {
          linkPath,
          targetPath,
          error: (err as Error).message,
        });
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE));
      }
    });
  }

  private async doHandleSymlink(
    sftp: SFTP,
    reqid: number,
    linkPath: string,
    targetPath: string,
  ): Promise<void> {
    if (!this.isOpen()) return;

    const resolved = await this.resolvePath(linkPath);
    const { vfsPath } = resolved;

    if (this.refuseInShadow(sftp, reqid, resolved)) {
      return;
    }
    if (!targetPath) {
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'empty link target'));
      return;
    }

    const releaseLock = await this.acquirePathLock(vfsPath);
    try {
      if (await this.config.vfs.exists(this.config.access, vfsPath, { follow: false })) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.FAILURE, 'file exists'));
        return;
      }

      // The target is stored as given, relative or absolute, as `ln -s` does.
      await this.config.vfs.create(
        this.config.access,
        NODE_TYPE_SOFTLINK,
        dirname(vfsPath),
        basename(vfsPath),
        {
          props: {
            uid: this.config.access.uid,
            gid: this.config.access.gid,
            mode: 0o777,
            softlink: targetPath,
          },
        },
      );
      this.sendResponse(() => sftp.status(reqid, STATUS_CODE.OK));
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        this.sendResponse(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      } else {
        throw err;
      }
    } finally {
      releaseLock();
    }
  }
}
