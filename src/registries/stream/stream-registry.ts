import { AbstractResourceHandle, type RegistryIf, type ResourceHandleIf, type ResourceMode, type ResourceOptions } from '../types.ts';
import { isPictureStream, STREAM_GRACE_MS, STREAM_PICTURE_FRESH_MS, STREAM_PICTURE_WAIT_MS, STREAM_READER_BUFFER, type StreamReader, type StreamWriter } from './types.ts';

/**
 * A stream's registry: live bytes from one writer to any number of readers, kept in this process's
 * memory and nowhere else. A reader joins at the latest start point its writer marked (a keyframe),
 * or at now when it marked none: it is given the stream's header, when its writer marked one, then
 * what was written since that start point, and then what is written from then on. Each reader holds what it has not read yet, up
 * to `STREAM_READER_BUFFER`; one that falls further behind reads to the end of what it holds and
 * then its end, so a writer never waits for anyone. A read waits while nothing has come, also while
 * the stream has no writer; the writer's close ends the stream for the readers there then.
 *
 * The writer's `wanted` says whether anyone reads, staying true `STREAM_GRACE_MS` after the last
 * reader left, so its producer runs only while it is read.
 *
 * A stream whose node is an `image/*` is a picture stream: each write is one whole picture, and a
 * reader is given one picture and then its end. The latest, when it is at most
 * `STREAM_PICTURE_FRESH_MS` old; otherwise the reader waits for the next, and while one waits the
 * writer is wanted, so a picture is made only when someone asks for it. A reader given none within
 * `STREAM_PICTURE_WAIT_MS` is given the latest there is, or its end.
 */
export class StreamRegistry implements RegistryIf {
  readonly #streams = new Map<string, LiveStream>();

  constructor(private readonly options: { graceMs?: number; readerBuffer?: number; pictureFreshMs?: number; pictureWaitMs?: number } = {}) {}

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const id of [...this.#streams.keys()]) this.#end(id);
  }

  async touch(_id: string, _opts: ResourceOptions): Promise<boolean> {
    return false;
  }

  /** `opts` are the node's attrs, as the VFS opens a stream: its `mimetype` says whether it is a picture stream. */
  async open(id: string, opts: ResourceOptions & { mimetype?: string }, mode: ResourceMode = 'r'): Promise<ResourceHandleIf> {
    if (mode.includes('+')) throw new Error(`a stream is read or written, not both (mode: ${mode})`);
    const pictures = isPictureStream(opts.mimetype)
      ? { freshMs: this.options.pictureFreshMs ?? STREAM_PICTURE_FRESH_MS, waitMs: this.options.pictureWaitMs ?? STREAM_PICTURE_WAIT_MS }
      : undefined;
    const stream = this.#streams.get(id) ??
      new LiveStream(this.options.graceMs ?? STREAM_GRACE_MS, this.options.readerBuffer ?? STREAM_READER_BUFFER, pictures, () => this.#streams.delete(id));
    this.#streams.set(id, stream);
    if (mode === 'r') return stream.join(new StreamReaderHandle(id, opts, mode, this, this.options.readerBuffer ?? STREAM_READER_BUFFER));
    if (stream.writer) throw new Error('the stream has a writer already');
    return stream.take(new StreamWriterHandle(id, opts, mode, this, stream));
  }

  async exists(_id: string): Promise<boolean> {
    return true;
  }

  /** A stream holds nothing, so its size is 0; `readers` and `writer` say who has it open now. */
  async stat(id: string): Promise<Record<string, unknown>> {
    const stream = this.#streams.get(id);
    return { size: 0, readers: stream?.readers.size ?? 0, writer: Boolean(stream?.writer) };
  }

  async statX(id: string): Promise<Record<string, unknown>> {
    return await this.stat(id);
  }

  /** The stream's node is gone: its writer and readers are closed. */
  async delete(id: string): Promise<boolean> {
    return this.#end(id);
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    const ids = [...this.#streams.keys()];
    return (async function* () {
      yield* ids;
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.#streams.size;
  }

  #end(id: string): boolean {
    const stream = this.#streams.get(id);
    if (!stream) return false;
    stream.endAll();
    this.#streams.delete(id);
    return true;
  }
}

/** How a picture stream gives its pictures: how old one may be when a reader joins, and how long a reader waits for the next. */
type Pictures = { freshMs: number; waitMs: number };

/**
 * One stream while anyone has it open: its writer, its readers, its header, what was written since
 * the latest start point, and whether it is wanted. In a picture stream, its readers are those
 * waiting for a picture, and `picture` the latest.
 */
class LiveStream {
  writer?: StreamWriterHandle;
  readonly readers = new Set<StreamReaderHandle>();
  header?: Uint8Array;
  /** What was written from the latest start point on; none past `limit` bytes, until the next. */
  since?: Uint8Array[];
  #sinceBytes = 0;
  picture?: { bytes: Uint8Array; at: number };
  wanted = false;
  readonly listeners = new Set<(wanted: boolean) => void>();
  #grace?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly graceMs: number,
    private readonly limit: number,
    private readonly pictures: Pictures | undefined,
    private readonly gone: () => void,
  ) {}

  join(reader: StreamReaderHandle): StreamReaderHandle {
    if (this.pictures) return this.joinPictures(reader, this.pictures);
    this.readers.add(reader);
    if (this.header) reader.push(this.header);
    for (const chunk of this.since ?? []) reader.push(chunk);
    reader.left = () => this.leave(reader);
    this.want();
    return reader;
  }

  /** A fresh picture now, or the next one, waited for while the writer is wanted. */
  private joinPictures(reader: StreamReaderHandle, pictures: Pictures): StreamReaderHandle {
    if (this.picture && Date.now() - this.picture.at <= pictures.freshMs) {
      reader.push(this.picture.bytes);
      reader.end();
      return reader;
    }
    this.readers.add(reader);
    const timer = setTimeout(() => {
      if (this.picture) reader.push(this.picture.bytes);
      reader.end();
    }, pictures.waitMs);
    reader.left = () => {
      clearTimeout(timer);
      this.leave(reader);
    };
    this.want();
    return reader;
  }

  take(writer: StreamWriterHandle): StreamWriterHandle {
    this.writer = writer;
    return writer;
  }

  leave(reader: StreamReaderHandle): void {
    if (!this.readers.delete(reader)) return;
    // A picture stream is wanted only while someone waits: the writer would make a picture for no one.
    if (this.readers.size === 0 && this.pictures) {
      this.set(false);
      this.forgetIfUnused();
    } else if (this.readers.size === 0) {
      clearTimeout(this.#grace);
      this.#grace = setTimeout(() => {
        this.#grace = undefined;
        if (this.readers.size === 0) this.set(false);
        this.forgetIfUnused();
      }, this.graceMs);
    }
  }

  /**
   * What the writer wrote, to every reader there now, and kept for joiners while a start point is;
   * in a picture stream, the latest picture, given to every reader waiting, each then at its end.
   */
  send(data: Uint8Array): void {
    if (this.pictures) {
      this.picture = { bytes: data, at: Date.now() };
      for (const reader of [...this.readers]) {
        reader.push(data);
        reader.end();
      }
      return;
    }
    if (this.since) {
      this.#sinceBytes += data.length;
      if (this.#sinceBytes > this.limit) this.since = undefined;
      else this.since.push(data);
    }
    this.broadcast(data);
  }

  /** `data` to every reader there now, and to no one who joins later. */
  broadcast(data: Uint8Array): void {
    for (const reader of this.readers) reader.push(data);
  }

  /** A start point: joiners from now on start with `data`. */
  start(data: Uint8Array): void {
    this.since = [];
    this.#sinceBytes = 0;
    this.send(data);
  }

  /** The writer closed: its readers read to their end, and the next writer starts without a header. */
  release(writer: StreamWriterHandle): void {
    if (this.writer !== writer) return;
    this.writer = undefined;
    this.header = undefined;
    this.since = undefined;
    this.listeners.clear();
    for (const reader of [...this.readers]) reader.end();
    this.forgetIfUnused();
  }

  endAll(): void {
    clearTimeout(this.#grace);
    this.#grace = undefined;
    for (const reader of [...this.readers]) reader.end();
    this.readers.clear();
    void this.writer?.close();
  }

  get isPictures(): boolean {
    return this.pictures !== undefined;
  }

  private want(): void {
    clearTimeout(this.#grace);
    this.#grace = undefined;
    this.set(true);
  }

  private set(wanted: boolean): void {
    if (this.wanted === wanted) return;
    this.wanted = wanted;
    for (const listener of [...this.listeners]) listener(wanted);
  }

  private forgetIfUnused(): void {
    if (!this.writer && this.readers.size === 0 && !this.#grace) this.gone();
  }
}

class StreamWriterHandle extends AbstractResourceHandle implements StreamWriter {
  constructor(id: string, options: ResourceOptions, mode: ResourceMode, registry: RegistryIf, private readonly stream: LiveStream) {
    super(id, options, mode, registry);
  }

  get wanted(): boolean {
    return !this._closed && this.stream.wanted;
  }

  onWanted(listener: (wanted: boolean) => void): () => void {
    this.assertNotClosed();
    this.stream.listeners.add(listener);
    return () => void this.stream.listeners.delete(listener);
  }

  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error('a stream is read by opening it to read');
  }

  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    // One copy for every reader: the caller may reuse its buffer once the write returns.
    if (data.length > 0) this.stream.send(data.slice());
    return data.length;
  }

  async writeHeader(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    if (this.stream.isPictures) return await this.write(data);
    const header = data.slice();
    this.stream.header = header;
    this.stream.broadcast(header);
    return data.length;
  }

  async writeStart(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    if (this.stream.isPictures) return await this.write(data);
    this.stream.start(data.slice());
    return data.length;
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    await super.close();
    this.stream.release(this);
  }
}

class StreamReaderHandle extends AbstractResourceHandle implements StreamReader {
  #chunks: Uint8Array[] = [];
  #held = 0;
  #ended = false;
  #behind = false;
  #waiting?: PromiseWithResolvers<void>;
  /** Set when it joins a stream: takes it out of the stream's readers. */
  left?: () => void;

  constructor(id: string, options: ResourceOptions, mode: ResourceMode, registry: RegistryIf, private readonly limit: number) {
    super(id, options, mode, registry);
  }

  get behind(): boolean {
    return this.#behind;
  }

  /** Bytes for this reader; past its limit it is let go, and reads what it holds and then its end. */
  push(data: Uint8Array): void {
    if (this.#ended) return;
    if (this.#held + data.length > this.limit) {
      this.#behind = true;
      return this.end();
    }
    this.#chunks.push(data);
    this.#held += data.length;
    this.#waiting?.resolve();
  }

  /** No more comes: what it holds is read, and then its end. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#waiting?.resolve();
    this.left?.();
  }

  async read(size: number | bigint, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    const want = Math.max(1, Number(size));
    while (this.#chunks.length === 0) {
      if (this.#ended) return new Uint8Array(0);
      signal?.throwIfAborted();
      this.signal.throwIfAborted();
      const waiting = this.#waiting = Promise.withResolvers<void>();
      const abort = () => waiting.reject(signal?.reason ?? this.signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        await waiting.promise;
      } finally {
        signal?.removeEventListener('abort', abort);
        this.signal.removeEventListener('abort', abort);
        if (this.#waiting === waiting) this.#waiting = undefined;
      }
    }
    // A chunk is shared by every reader, so each read answers a copy of its own, which the caller
    // may hand over.
    const first = this.#chunks[0];
    if (first.length <= want) {
      this.#chunks.shift();
      this.#held -= first.length;
      return first.slice();
    }
    this.#chunks[0] = first.subarray(want);
    this.#held -= want;
    return first.slice(0, want);
  }

  async write(_data: Uint8Array): Promise<number> {
    throw new Error('a stream is written by opening it to write');
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    await super.close();
    this.#chunks = [];
    this.#held = 0;
    this.#ended = true;
    this.left?.();
  }
}
