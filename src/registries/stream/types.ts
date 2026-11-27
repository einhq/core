import type { ResourceHandleIf } from '../types.ts';

/** What a reader may hold unread before it is let go: a reader that falls this far behind reads to its end. */
export const STREAM_READER_BUFFER = 8 * 1024 * 1024;

/** How long a stream stays wanted after its last reader left, so a reader opening it again finds it running. */
export const STREAM_GRACE_MS = 10_000;

/** How old a picture stream's latest picture may be and still be given to a reader at once: older, the reader asks for the next. */
export const STREAM_PICTURE_FRESH_MS = 2_000;

/** How long a reader of a picture stream waits for the next picture before it is given the latest there is, or its end. */
export const STREAM_PICTURE_WAIT_MS = 20_000;

/** Whether a stream of `mimetype` is a picture stream (`image/*`): each write one whole picture, each read the latest. */
export const isPictureStream = (mimetype: unknown): boolean => typeof mimetype === 'string' && mimetype.startsWith('image/');

/**
 * A stream's writer: the handle the VFS gives the one who opens a stream to write (`w` or `a`),
 * while nobody else holds it. What it writes reaches every reader there now, and is kept for no
 * one; a reader who falls behind is let go, never waited for. `wanted` says whether anyone reads,
 * so a producer runs only then. Closing it ends the stream for its readers.
 *
 * In a picture stream (`isPictureStream`) each write, of whichever kind, is one whole picture, and
 * `wanted` says whether a reader waits for a newer one than there is: the writer makes one then,
 * and none while nobody asks.
 */
export interface StreamWriter extends ResourceHandleIf {
  /** Whether someone reads the stream now, or did within the last `STREAM_GRACE_MS`; in a picture stream, whether a reader waits for a picture. */
  readonly wanted: boolean;
  /** Call `listener` each time `wanted` changes, until the handle closes; the answer stops it sooner. */
  onWanted(listener: (wanted: boolean) => void): () => void;
  /**
   * Write `data` as the stream's header (fragmented MP4's initialization segment): to the readers
   * there now as any write, and first to each reader who joins later, in place of the header before.
   */
  writeHeader(data: Uint8Array): Promise<number>;
  /**
   * Write `data` as a point a reader may start at (a keyframe): to the readers there now as any
   * write, and to each reader who joins later after the header, with all written since, until the
   * next start point.
   */
  writeStart(data: Uint8Array): Promise<number>;
}

/**
 * A stream's reader: the handle the VFS gives whoever opens a stream to read. Each read answers at
 * most one of the writer's writes, whole when the size asked for holds it.
 */
export interface StreamReader extends ResourceHandleIf {
  /** Whether it was let go for falling more than `STREAM_READER_BUFFER` behind, rather than the writer closing. */
  readonly behind: boolean;
}

/** Whether `handle` is a stream's reader, as the VFS opens one to read. */
export const isStreamReader = (handle: ResourceHandleIf): handle is StreamReader => typeof (handle as Partial<StreamReader>).behind === 'boolean';

/** Whether `handle` is a stream's writer, as the VFS opens one to write. */
export const isStreamWriter = (handle: ResourceHandleIf): handle is StreamWriter =>
  typeof (handle as Partial<StreamWriter>).onWanted === 'function' && typeof (handle as Partial<StreamWriter>).writeStart === 'function';
