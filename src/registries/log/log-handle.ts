import { AbstractResourceHandle, modeFlags, RegistryIf, ResourceHandleIf, ResourceMode, ResourceSeekMode } from '../types.ts';
import { LogEntry, LogEntryId, LogIO, LogResourceOptions, LogStat } from './types.ts';

export class LogHandle extends AbstractResourceHandle<LogResourceOptions, LogStat> implements ResourceHandleIf<LogResourceOptions, LogStat> {
  private lastId: LogEntryId | undefined = undefined;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    id: string,
    options: LogResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<LogResourceOptions, LogStat>,
    private io: LogIO,
  ) {
    super(id, options, mode, registry, 100);
  }

  /** Initialize the handle, seeking to end if opened in append mode. */
  override async init(): Promise<void> {
    const { append } = modeFlags(this.mode);

    if (append) {
      try {
        await this.seek(0, ResourceSeekMode.End);
      } catch {
        // seek fails on an empty log — position before the first entry
        this.lastId = undefined;
      }
    }
  }

  /** Return the total number of entries in the log. */
  override async size(): Promise<number> {
    const { size } = await this.registry.stat(this.id);
    return size;
  }

  /** Seek to a position in the log, updating the internal cursor. */
  override async seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    this.assertNotClosed();

    return this.lastId = await this.io.seek(offset, whence, this.lastId);
  }

  /** Read up to size entries; blocks if empty. Returns empty on EOF/abort. */
  async read(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    const entries = await this.io.read(size, this.lastId, signal);

    if (!entries || entries.length === 0) {
      return new Uint8Array(0);
    }

    const lines = entries.map(({ data }) => JSON.stringify(data) + '\n');
    this.lastId = entries[entries.length - 1].id;

    return this.encoder.encode(lines.join(''));
  }

  /** Read up to `size` entries with their metadata (id, createdAt, data); advances the cursor. Unlike read(), preserves timestamps — used for time-series (measurements, config). */
  async readEntries(size: number, signal?: AbortSignal): Promise<LogEntry[]> {
    this.assertNotClosed();
    this.assertCanRead();

    const entries = await this.io.read(size, this.lastId, signal);
    if (!entries || entries.length === 0) return [];
    this.lastId = entries[entries.length - 1].id;
    return entries;
  }

  /** Append a single entry at an explicit timestamp (backdating). Used to import historical series. */
  async appendAt(data: unknown, createdAt?: Date): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();
    this.lastId = await this.io.append(data, createdAt);
    return this.lastId;
  }

  /** Write newline-delimited JSON entries to the log. Returns the number of entries written. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    const text = this.decoder.decode(data).trim();
    const lines = text.split('\n').filter(Boolean);

    for (const line of lines) {
      this.lastId = await this.io.append(JSON.parse(line));
    }

    return lines.length;
  }
}
