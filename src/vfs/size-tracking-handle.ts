import { modeFlags, type ResourceHandleIf, type ResourceMode, type ResourceOptions, ResourceSeekMode, type ResourceStat } from '../registries/types.ts';
import { createSha256, type Sha256Hasher } from '../lib/hash/mod.ts';
import { MIME_SAMPLE_BYTES } from '../lib/media/mime.ts';

/**
 * Wraps a writable resource handle and reports the current size to `onFlush`
 * at each flush point (sync/writeEOF/close). Lets the VFS persist `attrs.size`
 * and emit an 'updated' event on write, so followers (tail -f) can subscribe
 * instead of polling.
 *
 * The flush is skipped only when nothing was written since the last report, not
 * when the size came out the same: an in-place overwrite of the same length
 * moves the content without moving `attrs.size`, and the node write is what
 * carries `modtime` and the 'updated' event, which a follower and any
 * mtime-keyed cache rely on.
 *
 * **`sha256` rides along with `size`**, hashed from the bytes as they go past —
 * it is a property of the content exactly as the length is, and computing it
 * here costs nothing extra because the writer already holds every byte.
 *
 * A streaming hash is only correct when the handle sees the whole file in
 * order, so it is kept **only for a write that starts from an empty file and
 * never seeks**: a truncating open, or any open of a file that was empty (an
 * SFTP client that creates with `EXCL` sends no `TRUNC`). An append to, or a
 * read-write open of, a non-empty file, or a seek, means the bytes on disk are
 * not the bytes that went past. Rather than leave the file with no hash, the
 * digest is then read back from the finished bytes at close (`statX`, which
 * streams and hashes) — one extra read, on the uncommon path, in exchange for
 * `attrs.sha256` being present after *every* write rather than only after
 * sequential ones.
 *
 * Intermediate flushes on that path report `null`, clearing the attr until the
 * read-back replaces it. Clearing rather than leaving the old value is
 * deliberate: a stale hash makes `duplicates` group unrelated files and makes
 * the ETag serve the wrong bytes, so if the process dies mid-write, no hash is
 * the safe thing to be left with.
 *
 * **The head of the file rides along too**, for the mimetype. A node's mimetype
 * is otherwise decided once, at creation, from a name that often says nothing
 * (`bashrc`, a `bin/` command) and a body that does not exist yet. The handle
 * keeps the first `MIME_SAMPLE_BYTES` that go past whenever they are the
 * first bytes of the file — a truncating write, or any write that started on an
 * empty file — and hands them to `onFlush` so the VFS can sniff an untyped node
 * again. An append to an existing file changes nothing about its head and
 * reports `undefined`.
 */
export class SizeTrackingHandle implements ResourceHandleIf {
  #lastReported: number;
  /** Bytes went through this handle since the last report. */
  #dirty: boolean;
  /**
   * Set while every byte of the file has gone past this handle in order, so the
   * running digest is the digest of what is on disk. Cleared by a seek.
   */
  #hasher: Sha256Hasher | undefined;
  /** How many bytes the digest covers — i.e. where a seek must land to be a no-op. */
  #hashedBytes: number;
  /**
   * Whether this handle ever changed the file — for its whole life, unlike
   * `#dirty`, which a flush resets. It is what decides whether a blind handle
   * owes a read-back at close: an intermediate flush has already cleared the
   * attr by then, so "nothing since the last report" is not "nothing to do".
   */
  #everWrote: boolean;
  /**
   * The file's leading bytes, filled while the handle is writing from offset 0
   * without having moved. `undefined` once the bytes going past are no longer
   * known to be the head (a non-empty append, a seek).
   */
  #head: Uint8Array | undefined;
  #headLength: number;

  constructor(
    private inner: ResourceHandleIf,
    private onFlush: (size: number, sha256: string | null, head: Uint8Array | undefined) => Promise<void>,
    startSize: number,
  ) {
    this.#lastReported = startSize;
    // A truncating open already changed the content before the first write, and
    // `startSize` is read after the truncation — so without this a 'w' open that
    // writes nothing leaves the old, larger `attrs.size` behind.
    this.#dirty = modeFlags(inner.mode).truncate;
    // Writing from an empty file is what makes a streaming digest, and the
    // bytes going past, the file's own.
    const fromEmpty = modeFlags(inner.mode).truncate || startSize === 0;
    this.#hasher = fromEmpty ? createSha256() : undefined;
    this.#hashedBytes = 0;
    this.#everWrote = false;
    this.#head = fromEmpty ? new Uint8Array(MIME_SAMPLE_BYTES) : undefined;
    this.#headLength = 0;
  }

  /** The bytes on disk are no longer the bytes that went past — stop claiming a hash. */
  #blind(): void {
    this.#hasher = undefined;
    this.#head = undefined;
  }

  #feed(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#hasher?.update(chunk);
    this.#hashedBytes += chunk.length;
    if (this.#head && this.#headLength < MIME_SAMPLE_BYTES) {
      const take = Math.min(MIME_SAMPLE_BYTES - this.#headLength, chunk.length);
      this.#head.set(chunk.subarray(0, take), this.#headLength);
      this.#headLength += take;
    }
    this.#dirty = true;
    this.#everWrote = true;
  }

  /** The head as written so far, or `undefined` when this handle never held it. */
  #headSample(): Uint8Array | undefined {
    return this.#head && this.#everWrote ? this.#head.subarray(0, this.#headLength) : undefined;
  }

  /**
   * `peekHex` rather than `hex`: close() reports after a sync() already did, and
   * finalising on the first would leave the second with a dead hasher.
   */
  private async report(size: number): Promise<void> {
    if (!this.#dirty && size === this.#lastReported) return;
    this.#dirty = false;
    this.#lastReported = size;
    await this.onFlush(size, this.#hasher?.peekHex() ?? null, this.#headSample());
  }

  /**
   * The same report, but at a terminal flush — so a handle that could not hash
   * as it went reads the finished bytes back instead of giving up on the attr.
   *
   * Skipped entirely when the streaming digest is still good, which is the
   * common case and costs nothing. It deliberately does not go through
   * `report`'s "nothing changed since the last flush" check: on this path an
   * earlier flush cleared the attr, and only the read-back can put a value back.
   */
  private async reportFinal(size: number): Promise<void> {
    if (this.#hasher || !this.#everWrote) return await this.report(size);

    let digest: string | null = null;
    try {
      // Registry-level read by id, so it sees the committed bytes and does not
      // depend on the handle still being open.
      digest = (await this.inner.statX() as { sha256?: string }).sha256 ?? null;
    } catch {
      // Unhashable (an unusual backend, a vanished file) — better no attr than
      // a wrong one.
    }
    this.#dirty = false;
    this.#lastReported = size;
    await this.onFlush(size, digest, this.#headSample());
  }

  get id(): string {
    return this.inner.id;
  }
  get options(): ResourceOptions {
    return this.inner.options;
  }
  get closed(): boolean {
    return this.inner.closed;
  }
  get mode(): ResourceMode {
    return this.inner.mode;
  }
  get signal(): AbortSignal {
    return this.inner.signal;
  }
  get readable(): ReadableStream<Uint8Array> {
    return this.inner.readable;
  }
  /**
   * Most callers pipe into `writable` rather than calling write(), so the
   * stream has to mark the handle dirty too. Chunks are forwarded to the inner
   * stream unchanged, which keeps its own sink (and its abort behaviour).
   */
  get writable(): WritableStream<Uint8Array> {
    const writer = this.inner.writable.getWriter();

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await writer.write(chunk);
        this.#feed(chunk);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
  }

  init(): Promise<void> {
    return this.inner.init();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  stat(): Promise<ResourceStat> {
    return this.inner.stat();
  }
  statX(): Promise<ResourceStat> {
    return this.inner.statX();
  }
  /**
   * Writing somewhere other than where the digest is up to breaks it, and the
   * handle cannot tell a rewind-then-rewrite from a sparse skip — so a real seek
   * gives up on the running digest.
   *
   * A seek that lands exactly where the digest already ends is not a real seek.
   * That case is worth spelling out because it is *the* SFTP write path: the
   * protocol addresses every write packet by offset, so the server seeks before
   * each one. Treating those as movement would make every
   * upload blind on its first packet and pay a full re-read at close.
   */
  seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    const stationary = (whence === ResourceSeekMode.Start && Number(offset) === this.#hashedBytes) ||
      (whence === ResourceSeekMode.Current && Number(offset) === 0);
    if (!stationary) this.#blind();
    return this.inner.seek(offset, whence);
  }
  read(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.inner.read(size, signal);
  }
  async write(data: Uint8Array): Promise<number> {
    const written = await this.inner.write(data);
    this.#feed(data);
    return written;
  }

  async writeEOF(): Promise<void> {
    // Capture size first — the default writeEOF() closes the inner handle.
    const size = await this.inner.size();
    await this.inner.writeEOF();
    await this.reportFinal(size);
  }

  async sync(): Promise<void> {
    await this.inner.sync();
    await this.report(await this.inner.size());
  }

  async close(): Promise<void> {
    // Capture size before close: disk re-stats, pg-blob's tx still sees the
    // written bytes. Then close commits, and we report the final size.
    let size: number | undefined;
    try {
      size = await this.inner.size();
    } catch {
      size = undefined;
    }
    await this.inner.close();
    if (size !== undefined) await this.reportFinal(size);
  }
}
