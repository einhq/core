import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import {
  TrackIO,
  TrackPoint,
  TrackPointInput,
  TrackRange,
  TrackReadOptions,
  TrackReadResult,
  TrackResourceOptions,
  TrackSelection,
  TrackStat,
  TrackSummary,
  TrackVerdict,
} from './types.ts';

/** Points fetched per read of the byte-stream view. */
const PAGE = 100;

/** How often, at most, a handle that stays open reports that its fixes changed. */
const CHANGE_REPORT_MS = 5000;

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
  /** The fixes changed since the last report. */
  private unreported = false;
  /** When `onChanged` last ran, in ms since the epoch; 0 before the first. */
  private reportedAt = 0;

  /**
   * Called after the track's fixes changed — appended, deleted, marked, or moved
   * in or out — so the owner can tell subscribers. It runs on the first change,
   * then at most once every few seconds while the handle stays open, and on close
   * for any change not yet reported; never when a call changed nothing (every
   * point a duplicate, every verdict already given).
   */
  onChanged?: () => Promise<void>;

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
    await this.report();
  }

  private async appendLines(lines: string[]): Promise<number> {
    const points = lines.map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as TrackPoint);

    if (points.length === 0) return 0;

    await this.changed(await this.io.append(points));

    return points.length;
  }

  /** Append points, upserting on timestamp. Returns rows written. */
  async appendPoints(points: TrackPointInput[]): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    const written = await this.io.append(points);
    await this.changed(written);
    return written;
  }

  /** Note that `count` fixes changed, and report it unless one was reported a moment ago. */
  private async changed(count: number): Promise<void> {
    if (count === 0) return;
    this.unreported = true;
    if (Date.now() - this.reportedAt >= CHANGE_REPORT_MS) await this.report();
  }

  private async report(): Promise<void> {
    if (!this.unreported || !this.onChanged) return;
    this.unreported = false;
    this.reportedAt = Date.now();
    await this.onChanged();
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

    const removed = await this.io.remove(range);
    await this.changed(removed);
    return removed;
  }

  /** Set a person's verdict on a selection, or clear it with null. Returns the fixes whose verdict changed. */
  async markPoints(selection: TrackSelection, verdict: TrackVerdict | null): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    const marked = await this.io.mark(selection, verdict);
    await this.changed(marked);
    return marked;
  }

  /**
   * Move the fixes of a time range to the track `to` is open on, which has to be open for writing
   * and kept by the same registry. A fix whose timestamp `to` already holds leaves this track all
   * the same. Returns the fixes moved; both handles report the change.
   */
  async movePoints(range: TrackRange, to: TrackHandle): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();
    if (!(to instanceof TrackHandle) || to.registry !== this.registry) throw new Error('fixes move only to a track kept in the same store');
    to.assertNotClosed();
    to.assertCanWrite();

    const moved = await this.io.move(range, to.id);
    await this.changed(moved);
    await to.changed(moved);
    return moved;
  }

  /** Point count, time span and extent, without reading the points. */
  async summary(): Promise<TrackSummary> {
    this.assertNotClosed();

    return await this.io.summary();
  }
}
