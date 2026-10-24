import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode, ResourceOptions, ResourceSeekMode } from '../types.ts';
import { FileStat, FileStatX } from './types.ts';

export class DiskFileHandle extends AbstractResourceHandle<ResourceOptions, FileStat, FileStatX> implements ResourceHandleIf<ResourceOptions, FileStat, FileStatX> {
  private file: Deno.FsFile | undefined;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<ResourceOptions, FileStat, FileStatX>,
    private abspath: string,
  ) {
    super(id, options, mode, registry);
  }

  /** Opens the underlying Deno file with the appropriate mode flags. */
  override async init(): Promise<void> {
    this.file = await Deno.open(this.abspath, this.modeToDenoOptions(this.mode));
  }

  /** Returns the current file size in bytes by stat-ing the file on disk. */
  override async size(): Promise<number> {
    const { size } = await Deno.stat(this.abspath);
    return size;
  }

  /** Throws if the handle is closed or not yet initialized. */
  override assertNotClosed(): void {
    super.assertNotClosed();

    if (!this.file) {
      throw new Error('handle is not initialized');
    }
  }

  /** Moves the file cursor to the given offset relative to whence. Returns the new position. */
  override async seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    this.assertNotClosed();

    return await this.file!.seek(offset, whence as unknown as Deno.SeekMode);
  }

  /** Read up to size; waits if empty. Returns empty on EOF. */
  async read(size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    const out = new Uint8Array(size);
    // Deno.FsFile.read takes no signal; a disk read returns promptly anyway.
    const readBytes = await this.file!.read(out);

    if (readBytes === null) {
      return new Uint8Array(0);
    }

    if (readBytes < size) {
      return out.slice(0, readBytes);
    }

    return out;
  }

  /** Write bytes or string. Waits when buffer is full. Throws if closed. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    return await this.file!.write(data);
  }

  /** Flushes pending writes to the underlying storage device. */
  override async sync(): Promise<void> {
    this.assertNotClosed();
    this.assertCanWrite();

    await this.file!.sync();
  }

  /** Closes the file handle and releases the underlying file descriptor. */
  override async close(): Promise<void> {
    await super.close();

    if (this.file) {
      try {
        this.file.close();
      } catch {
        // file descriptor may already be closed
      }
      this.file = undefined;
    }
  }

  private modeToDenoOptions(mode: string): Deno.OpenOptions {
    switch (mode) {
      case 'r':
        return { read: true };
      case 'w':
        return { write: true, create: true, truncate: true };
      case 'a':
        return { write: true, create: true, append: true };
      case 'r+':
        return { read: true, write: true, create: true };
      case 'w+':
        return { read: true, write: true, create: true, truncate: true };
      case 'a+':
        return { read: true, write: true, create: true, append: true };
      default:
        return { read: true };
    }
  }
}
