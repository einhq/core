import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { TrackIO, TrackPoint, TrackRange, TrackReadOptions, TrackReadResult, TrackResourceOptions, TrackStat, TrackSummary } from './types.ts';

/** Points fetched per read of the byte-stream view. */
const PAGE = 100;

/**
 * Byte-stream view of a track, so `cat` and `tail -f` work on one.
 *
 * Reading yields points as JSONL in timestamp order — non-destructive, and
 * blocking when a signal is given, the way a log's read blocks. Writing appends
 * points, one JSON object per line. The typed methods are what the map actually
 * uses; the stream is for the shell.
 */
export class TrackHandle extends AbstractResourceHandle<TrackResourceOptions, TrackStat> implements ResourceHandleIf<TrackResourceOptions, TrackStat> {
  private buffer: TrackPoint[] = [];
  private cursor: string | undefined = undefined;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  /** Bytes of a line that arrived without its newline yet. */
  private pending = '';

  constructor(
    id: string,
    options: TrackResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<TrackResourceOptions, TrackStat>,
    private io: TrackIO,
  ) {
    super(id, options, mode, registry, 1);
  }

  /** Number of points, matching what `stat` reports as `size`. */
  override async size(): Promise<number> {
    const { size } = await this.registry.stat(this.id);
    return size;
  }

  /** Next point as JSONL, or empty at the end. Blocks on a signal, like a log. */
  async read(_size: number | bigint, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    if (this.buffer.length === 0) {
      this.buffer = await this.io.page(this.cursor, PAGE, signal);

      if (this.buffer.length > 0) {
        this.cursor = this.buffer[this.buffer.length - 1].ts;
      }
    }

    const point = this.buffer.shift();

    if (!point) {
      return new Uint8Array(0);
    }

    return this.encoder.encode(JSON.stringify(point) + '\n');
  }

  /**
   * Append points, one JSON object per line.
   *
   * A partial trailing line is held back rather than parsed: a redirect writes
   * in fixed-size chunks and will cut a point in half, so a stream of a few
   * hundred fixes would otherwise fail on whichever line straddled the
   * boundary. `writeEOF`/`close` flushes what is left.
   */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    this.pending += this.decoder.decode(data, { stream: true });

    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';

    return await this.appendLines(lines);
  }

  /** Flush a trailing line that arrived without its newline. */
  override async writeEOF(): Promise<void> {
    if (this.pending.trim().length > 0) {
      const rest = this.pending;
      this.pending = '';
      await this.appendLines([rest]);
    }

    await super.writeEOF();
  }

  override async close(): Promise<void> {
    if (!this.closed && this.pending.trim().length > 0 && (this.mode.includes('w') || this.mode.includes('a') || this.mode.includes('+'))) {
      const rest = this.pending;
      this.pending = '';
      await this.appendLines([rest]);
    }

    await super.close();
  }

  private async appendLines(lines: string[]): Promise<number> {
    const points = lines.map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as TrackPoint);

    if (points.length === 0) return 0;

    await this.io.append(points);

    return points.length;
  }

  /** Append points, upserting on timestamp. Returns rows written. */
  async appendPoints(points: TrackPoint[]): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    return await this.io.append(points);
  }

  /** Read the track as drawable segments. */
  async readPoints(opts: TrackReadOptions = {}): Promise<TrackReadResult> {
    this.assertNotClosed();
    this.assertCanRead();

    return await this.io.read(opts);
  }

  /** Delete a time range. Returns rows removed. */
  async deletePoints(range: TrackRange): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    return await this.io.remove(range);
  }

  /** Point count, time span and extent, without reading the points. */
  async summary(): Promise<TrackSummary> {
    this.assertNotClosed();

    return await this.io.summary();
  }
}
