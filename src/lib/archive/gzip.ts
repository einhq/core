/**
 * gzip as web streams.
 *
 * Through `node:zlib` rather than the runtime's DecompressionStream: that refuses a stream of
 * several gzip members one after the other, which `gzip` itself writes when files are concatenated,
 * and zeros after the end, which a tape-sized block leaves; zlib reads both as gzip(1) does.
 */

import { Duplex } from 'node:stream';
import { constants, createGunzip, createGzip } from 'node:zlib';

/** The two bytes every gzip member starts with. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Whether `bytes` starts as a gzip stream does. */
const isGzip = (bytes: Uint8Array): boolean => bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];

const asTransform = (duplex: Duplex) => Duplex.toWeb(duplex) as unknown as TransformStream<Uint8Array, Uint8Array>;

/** Decompress a gzip stream: one member or several, zeros after the last passed over. */
export const gunzipStream = (): TransformStream<Uint8Array, Uint8Array> => asTransform(createGunzip());

/** Compress into one gzip member, at `level` from 1 (fastest) to 9 (smallest); 6 when not given. */
export const gzipStream = (level: number = constants.Z_DEFAULT_COMPRESSION): TransformStream<Uint8Array, Uint8Array> => asTransform(createGzip({ level }));

/**
 * The stream with its first bytes looked at: `stream` read again from its start, and whether it is
 * gzip. Nothing is read beyond the first chunk.
 */
export const peekGzip = async (stream: ReadableStream<Uint8Array>): Promise<{ stream: ReadableStream<Uint8Array>; gzip: boolean }> => {
  const reader = stream.getReader();
  const head: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < GZIP_MAGIC.length) {
    const read = await reader.read();
    if (read.done) {
      done = true;
      break;
    }
    head.push(read.value);
    length += read.value.length;
  }
  const first = head.length === 1 ? head[0] : new Uint8Array(head.flatMap((chunk) => [...chunk]));
  const again = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.length > 0) controller.enqueue(first);
      if (done) controller.close();
    },
    async pull(controller) {
      const read = await reader.read();
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream: again, gzip: isGzip(first) };
};
