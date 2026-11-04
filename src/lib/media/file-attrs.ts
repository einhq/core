import { getMimeFromBuffer, MIME_SAMPLE_BYTES } from './mime.ts';

type ComputedFileAttrs = {
  size: number;
  mimetype: string;
};

type FileAttrsCollector = {
  stream: TransformStream<Uint8Array, Uint8Array>;
  finalize(): Promise<ComputedFileAttrs>;
};

/**
 * Pass-through stream that computes size and content-sniffed mimetype for the
 * bytes flowing through it, of the file called `name` (which a camera RAW's or
 * a sidecar's mimetype is told by). Call finalize() after the stream
 * completes. It does not hash: a VFS write handle records the sha256 of what
 * it wrote.
 */
export function createFileAttrsCollector(name?: string): FileAttrsCollector {
  let size = 0;

  // Sniffing needs at most MIME_SAMPLE_BYTES, so allocate exactly that once
  // and fill it, rather than copying a whole 64 KB chunk to look at a few
  // hundred bytes on every upload and every SFTP write.
  const sample = new Uint8Array(MIME_SAMPLE_BYTES);
  let sampled = 0;

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;

      if (sampled < MIME_SAMPLE_BYTES) {
        const take = Math.min(MIME_SAMPLE_BYTES - sampled, chunk.byteLength);
        sample.set(chunk.subarray(0, take), sampled);
        sampled += take;
      }

      controller.enqueue(chunk);
    },
  });

  return {
    stream,
    async finalize(): Promise<ComputedFileAttrs> {
      return {
        size,
        // Trimmed to what was actually read — a short file must not be sniffed
        // against a tail of zero padding.
        mimetype: await getMimeFromBuffer(sample.subarray(0, sampled), name),
      };
    },
  };
}
