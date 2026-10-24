/** Options passed to touch/open. Extended per registry type. */
export type ResourceOptions = {
  /** Chunk size used when creating ReadableStream/WritableStream from a handle. */
  streamChunkSize?: number;
};

export enum ResourceSeekMode {
  /** Seek from the start of the resource. */
  Start = 0,
  /** Seek from the current position within the resource. */
  Current = 1,
  /** Seek from the end of the resource. */
  End = 2,
}

/**
 * File access mode.
 * - 'r': Read only
 * - 'w': Write only (truncates)
 * - 'a': Append only
 * - 'r+': Read and write
 * - 'w+': Read and write (truncates)
 * - 'a+': Read and append
 */
export type ResourceMode = 'r' | 'w' | 'a' | 'r+' | 'w+' | 'a+';

export type ResourceStat = Record<string, unknown>;

/**
 * Handle to an open resource. Provides read/write/seek operations
 * and Web Streams integration.
 */
export interface ResourceHandleIf<
  TOptions extends ResourceOptions = ResourceOptions,
  TStat = ResourceStat,
  TStatX extends TStat = TStat,
> {
  /** Unique identifier for this resource. */
  readonly id: string;
  /** Options this handle was opened with. */
  readonly options: TOptions;
  /** Whether this handle has been closed. */
  readonly closed: boolean;
  /** The access mode this handle was opened with. */
  readonly mode: ResourceMode;
  /** AbortSignal that fires when the handle is closed. */
  readonly signal: AbortSignal;
  /** A ReadableStream backed by this handle. */
  readonly readable: ReadableStream<Uint8Array>;
  /** A WritableStream backed by this handle. */
  readonly writable: WritableStream<Uint8Array>;

  /** Initialize the handle (e.g. open underlying file descriptor). */
  init(): Promise<void>;

  /** Returns the size of the resource in bytes. */
  size(): Promise<number>;
  /** Returns basic metadata about the resource. */
  stat(): Promise<TStat>;
  /** Returns extended metadata (e.g. SHA-256, MIME type). */
  statX(): Promise<TStatX>;

  /** Seek to a position. Returns the new absolute position. */
  seek(offset: number, whence: ResourceSeekMode): Promise<number>;

  /** Read up to `size` bytes. Returns empty Uint8Array on EOF. */
  read(size: number, signal?: AbortSignal): Promise<Uint8Array>;

  /** Write data. Returns number of bytes written. */
  write(data: Uint8Array): Promise<number>;
  /** Signal end-of-file to readers. */
  writeEOF(): Promise<void>;

  /** Flush buffered data to the underlying storage. */
  sync(): Promise<void>;
  /** Close the handle and release resources. */
  close(): Promise<void>;
}

/**
 * Registry manages a collection of named resources.
 * Each resource is identified by a string ID and can be opened
 * as a ResourceHandleIf for reading/writing.
 */
export interface RegistryIf<
  TOptions extends ResourceOptions = ResourceOptions,
  TStat = Record<string, unknown>,
  TStatX extends TStat = TStat,
> {
  /** Initialize the registry (create tables, directories, etc.). */
  init(): Promise<void>;
  /** Tear down the registry and release all held resources. */
  dispose(): Promise<void>;

  /**
   * Create a resource if it doesn't exist.
   * @returns true if created, false if already existed.
   */
  touch(id: string, opts: TOptions): Promise<boolean>;

  /**
   * Open a resource for reading/writing. Auto-creates if mode implies writing.
   * @throws If resource doesn't exist and mode is read-only.
   */
  open(
    id: string,
    opts: TOptions,
    mode?: ResourceMode,
  ): Promise<ResourceHandleIf<TOptions, TStat, TStatX>>;

  /** Check whether a resource exists. */
  exists(id: string): Promise<boolean>;

  /**
   * Returns basic metadata for a resource. `opts` (the node attrs) is optional
   * and lets composite registries route by attrs (e.g. storage tier).
   */
  stat(id: string, opts?: TOptions): Promise<TStat>;
  /** Returns extended metadata for a resource. `opts` as in {@link stat}. */
  statX(id: string, opts?: TOptions): Promise<TStatX>;

  /**
   * Delete a resource. `opts` as in {@link stat}.
   * @returns true if deleted, false if not found.
   */
  delete(id: string, opts?: TOptions): Promise<boolean>;

  /** List resource IDs, optionally scoped by a prefix/parent. */
  list(id?: string): Promise<AsyncIterable<string>>;
  /** Count resources, optionally scoped by a prefix/parent. */
  count(id?: string): Promise<number>;
}

/**
 * Checks existence and auto-creates a resource if the mode implies writing.
 * @returns Whether the resource should be truncated.
 */
export async function ensureResource<TOptions extends ResourceOptions>(
  registry: RegistryIf<TOptions>,
  id: string,
  opts: TOptions,
  mode?: ResourceMode,
): Promise<{ truncate: boolean }> {
  const create = mode &&
    (mode.includes('w') || mode.includes('a') || mode.includes('+'));
  const exists = await registry.exists(id);

  if (!create && !exists) {
    throw new Error(`resource not found: ${id}`);
  } else if (create && !exists) {
    await registry.touch(id, opts);
  }

  return { truncate: mode?.includes('w') ?? false };
}

/** Derives truncate/append flags from a ResourceMode. */
export function modeFlags(mode: ResourceMode): {
  truncate: boolean;
  append: boolean;
} {
  switch (mode) {
    case 'w':
    case 'w+':
      return { truncate: true, append: false };
    case 'a':
    case 'a+':
      return { truncate: false, append: true };
    default:
      return { truncate: false, append: false };
  }
}

/**
 * Base class for resource handles. Provides mode assertions,
 * Web Streams integration, and default no-op implementations.
 */
export abstract class AbstractResourceHandle<
  TOptions extends ResourceOptions = ResourceOptions,
  TStat = Record<string, unknown>,
  TStatX extends TStat = TStat,
> implements ResourceHandleIf<TOptions, TStat, TStatX> {
  protected _closed = false;
  protected _position = 0;
  protected abortController = new AbortController();

  constructor(
    public readonly id: string,
    public readonly options: TOptions,
    public readonly mode: ResourceMode,
    protected registry: RegistryIf<TOptions, TStat, TStatX>,
    protected chunkSize = 16384,
  ) {}

  get closed(): boolean {
    return this._closed;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async init(): Promise<void> {
    // Default no-op
  }

  /** @throws If the handle is closed. */
  protected assertNotClosed(): void {
    if (this._closed) {
      throw new Error('handle is closed');
    }
  }

  /** @throws If the handle was not opened for reading. */
  protected assertCanRead(): void {
    if (!this.mode.includes('r') && !this.mode.includes('+')) {
      throw new Error(`handle not opened for reading (mode: ${this.mode})`);
    }
  }

  /** @throws If the handle was not opened for writing. */
  protected assertCanWrite(): void {
    if (
      !this.mode.includes('w') && !this.mode.includes('a') &&
      !this.mode.includes('+')
    ) {
      throw new Error(`handle not opened for writing (mode: ${this.mode})`);
    }
  }

  async size(): Promise<number> {
    return 0;
  }

  async stat(): Promise<TStat> {
    return await this.registry.stat(this.id);
  }

  async statX(): Promise<TStatX> {
    return await this.registry.statX(this.id);
  }

  async seek(
    _offset: number | bigint,
    _whence: ResourceSeekMode,
  ): Promise<number> {
    return 0;
  }

  abstract read(size: number | bigint, signal?: AbortSignal): Promise<Uint8Array>;

  abstract write(data: Uint8Array): Promise<number>;

  /** Signal EOF. Default implementation calls close(). */
  async writeEOF(): Promise<void> {
    await this.close();
  }

  async sync(): Promise<void> {
    // Default no-op
  }

  /** Close the handle, abort pending operations, and release resources. */
  async close(): Promise<void> {
    this.abortController.abort();
    this._closed = true;
  }

  /** Get a ReadableStream that pulls from this handle. */
  get readable(): ReadableStream<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    const handleSignal = this.abortController.signal;
    const streamAbort = new AbortController();
    const onHandleAbort = () => streamAbort.abort();

    if (handleSignal.aborted) {
      streamAbort.abort();
    } else {
      handleSignal.addEventListener('abort', onHandleAbort, { once: true });
    }

    // Streams outlive neither the handle nor the consumer; drop the listener on
    // every exit path so a long-lived handle doesn't accumulate one per stream.
    const detach = () => handleSignal.removeEventListener('abort', onHandleAbort);

    const closeQuietly = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      try {
        controller.close();
      } catch {
        // Already closed or errored by another path — nothing to do.
      }
    };

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await this.read(this.chunkSize, streamAbort.signal);

          if (chunk.length === 0) {
            detach();
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        } catch (error) {
          detach();

          // An abort here is ordinary termination: the handle closed, or the
          // consumer went away (a browser tab closing mid-stream is enough).
          // Letting it propagate rejects the pull promise, which surfaces as an
          // unhandled rejection and takes the whole process down with it.
          if (streamAbort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            closeQuietly(controller);
            return;
          }

          throw error;
        }
      },
      cancel: () => {
        detach();
        streamAbort.abort();
      },
    });
  }

  /** Get a WritableStream that pushes to this handle. */
  get writable(): WritableStream<Uint8Array> {
    this.assertNotClosed();
    this.assertCanWrite();

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.write(chunk);
      },
      abort: () => {
        this.close();
      },
    });
  }
}
