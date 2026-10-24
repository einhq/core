/**
 * Streams over an open SFTP file handle, with several requests in flight so a
 * transfer is not one round trip per chunk.
 */

import type { SFTP } from 'ssh2';

/** A mode's file-type bits, as SFTP attributes carry them */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

type SftpHandle = Uint8Array;

interface StreamOptions {
  /** Byte offset to start at (default 0) */
  position?: number;
  /** Bytes per request (default 64 KiB) */
  chunkSize?: number;
  /** Requests in flight (default 16) */
  concurrency?: number;
}

const CHUNK = 64 * 1024;
const CONCURRENCY = 16;

/**
 * Read from `position` to the end of the file. Reads are issued ahead and
 * delivered in order; a short read (which a server may answer before the end)
 * is completed before anything after it is delivered.
 */
export function sftpReadable(sftp: SFTP, handle: SftpHandle, opts: StreamOptions = {}): ReadableStream<Uint8Array> {
  const chunkSize = opts.chunkSize ?? CHUNK;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  let next = opts.position ?? 0;
  let eof = false;
  const inflight: { pos: number; len: number; data: Promise<Uint8Array> }[] = [];

  const issue = (pos: number, len: number) => {
    const buf = new Uint8Array(len);
    const data = sftp.read(handle, buf, 0, len, pos).then((n) => buf.subarray(0, n));
    data.catch(() => {}); // surfaced when it reaches the head of the queue
    return { pos, len, data };
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!eof && inflight.length < concurrency) {
        inflight.push(issue(next, chunkSize));
        next += chunkSize;
      }

      const head = inflight.shift();
      if (!head) {
        controller.close();
        return;
      }

      const data = await head.data;
      if (data.length === 0) {
        eof = true;
        inflight.length = 0;
        controller.close();
        return;
      }
      if (data.length < head.len) inflight.unshift(issue(head.pos + data.length, head.len - data.length));
      controller.enqueue(data);
    },
    cancel() {
      eof = true;
      inflight.length = 0;
    },
  }, { highWaterMark: 0 });
}

/**
 * Write sequentially from `position`, keeping up to `concurrency` writes
 * unacknowledged. Closing waits for every acknowledgement; the first failure
 * fails the next write or the close.
 */
export function sftpWritable(sftp: SFTP, handle: SftpHandle, opts: StreamOptions = {}): WritableStream<Uint8Array> {
  const chunkSize = opts.chunkSize ?? CHUNK;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  let pos = opts.position ?? 0;
  const pending = new Set<Promise<void>>();
  let failure: unknown;

  const drainTo = async (limit: number) => {
    while (pending.size > limit) await Promise.race(pending);
    if (failure) throw failure;
  };

  return new WritableStream<Uint8Array>({
    async write(chunk) {
      for (let off = 0; off < chunk.length; off += chunkSize) {
        await drainTo(concurrency - 1);
        const part = chunk.slice(off, off + chunkSize);
        const done: Promise<void> = sftp.write(handle, part, 0, part.length, pos)
          .catch((err) => {
            failure ??= err;
          })
          .finally(() => pending.delete(done));
        pending.add(done);
        pos += part.length;
      }
    },
    async close() {
      await drainTo(0);
    },
    async abort() {
      await Promise.allSettled(pending);
    },
  });
}

/** SFTP attribute times are seconds; ssh2 may hand back a Date */
export function sftpTimeMs(t: number | Date | undefined): number | undefined {
  if (t === undefined) return undefined;
  return t instanceof Date ? t.getTime() : t * 1000;
}

/** What an SFTP attributes' mode says the entry is */
export function sftpKind(attrs: { mode?: number }): 'directory' | 'file' | 'link' | 'other' {
  const type = (attrs.mode ?? 0) & S_IFMT;
  if (type === S_IFDIR) return 'directory';
  if (type === S_IFREG) return 'file';
  if (type === S_IFLNK) return 'link';
  return 'other';
}
