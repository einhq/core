/**
 * Streaming SHA-256, on the platform's native implementation.
 *
 * Several registries hash the same way — read a file or blob in 64 KB chunks,
 * update, hex-digest — and `file-sync` puts that on the crawl's hot path
 * several times per media file, all of it main-thread CPU. A pure-JS hash is
 * an order of magnitude slower than `node:crypto`'s native `createHash`.
 *
 * `crypto.subtle.digest` is *not* the answer here despite being the obvious web
 * API: it takes a whole BufferSource and rejects an async iterable, so it
 * cannot hash a stream without buffering the entire file.
 */

import { createHash } from 'node:crypto';
import type { Sha256WorkerReply, Sha256WorkerRequest } from './sha256-worker.ts';

type Sha256Hasher = {
  update(chunk: Uint8Array): void;
  /** Lowercase hex digest. Finalises the hasher — call once. */
  hex(): string;
};

export const createSha256 = (): Sha256Hasher => {
  const hash = createHash('sha256');

  return {
    update: (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    hex: () => hash.digest('hex'),
  };
};

/**
 * A SHA-256 of a stream of bytes, hashed on a worker thread, so that hashing
 * a large upload as it is written does not take the main thread's time.
 */
export type Sha256Stream = {
  /**
   * Takes the next bytes. They are copied, so the caller may reuse `chunk`,
   * unless `transfer` hands its ArrayBuffer over with it: the caller neither
   * reads nor reuses that buffer again, and the stream sends it to the hashing
   * thread as it is.
   */
  update(chunk: Uint8Array, transfer?: boolean): void;
  /** Digest of everything fed so far, leaving the stream usable. */
  peekHex(): Promise<string>;
  /** Drops the stream's state. A digest asked for after this is refused. */
  free(): void;
};

/**
 * Bytes collect in batches of this size, each handed to the worker whole: one
 * message per batch instead of one per write. Bytes handed over (`transfer`)
 * go in the same message as they are, without being copied into a batch. A
 * stream that never collects this much is hashed where it is, and never
 * starts the worker, which costs more main thread time than hashing a batch.
 */
const STREAM_BATCH = 1024 * 1024;

/** How long the worker outlives its last stream, so that a run of uploads starts it once. */
const IDLE_MS = 1000;

/**
 * Batch buffers the worker gave back. Filling a fresh megabyte faults in every
 * page of it, which costs the main thread more than the copy into it.
 */
const spareBatches: ArrayBuffer[] = [];
const MAX_SPARE_BATCHES = 8;

type Sha256Thread = {
  worker: Worker;
  replies: Map<number, { resolve: (hex: string) => void; reject: (error: Error) => void }>;
  nextSeq: number;
  /** Streams whose state is in the worker. */
  streams: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

let thread: Sha256Thread | undefined;
let nextStreamId = 1;

const stopThread = (stopping: Sha256Thread, error: Error) => {
  if (thread === stopping) thread = undefined;
  clearTimeout(stopping.idleTimer);
  stopping.worker.terminate();
  for (const reply of stopping.replies.values()) reply.reject(error);
  stopping.replies.clear();
};

/**
 * Stops the worker once it holds nothing and nobody waits on it. The timer
 * does not keep the process alive, but the worker does until the timer fires.
 */
const releaseThread = (owner: Sha256Thread) => {
  if (owner !== thread || owner.streams > 0 || owner.replies.size > 0) return;
  clearTimeout(owner.idleTimer);
  const timer = setTimeout(() => {
    if (owner.streams === 0 && owner.replies.size === 0) stopThread(owner, new Error('the sha256 thread stopped'));
  }, IDLE_MS);
  Deno.unrefTimer(timer);
  owner.idleTimer = timer;
};

/** The hashing thread, started on first use; a thread that fails takes its streams' states with it. */
const sha256Thread = (): Sha256Thread => {
  if (thread) {
    clearTimeout(thread.idleTimer);
    return thread;
  }
  const worker = new Worker(new URL('./sha256-worker.ts', import.meta.url), { type: 'module' });
  const started: Sha256Thread = { worker, replies: new Map(), nextSeq: 1, streams: 0 };
  worker.onmessage = ({ data }: MessageEvent<Sha256WorkerReply>) => {
    if ('buffer' in data) {
      if (data.buffer.byteLength === STREAM_BATCH && spareBatches.length < MAX_SPARE_BATCHES) spareBatches.push(data.buffer);
      return;
    }
    const reply = started.replies.get(data.seq);
    if (!reply) return;
    started.replies.delete(data.seq);
    reply.resolve(data.hex);
    releaseThread(started);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stopThread(started, new Error(`the sha256 thread failed: ${event.message}`));
  };
  thread = started;
  return started;
};

/** A stream dropped without free() releases its state in the worker. */
const unfreed = new FinalizationRegistry<() => void>((release) => release());

export const createSha256Stream = (): Sha256Stream => {
  const id = nextStreamId++;
  /** The bytes not yet sent, in order: views of copy batches and the chunks handed over. */
  let parts: Uint8Array[] = [];
  let partsLength = 0;
  /** The buffers handed over (`transfer`) that `parts` hold. */
  let given: ArrayBuffer[] = [];
  /** Earlier copy batches that `parts` still view, replaced by a larger one. */
  let outgrown: ArrayBuffer[] = [];
  /** The batch copies go into; its bytes from `cut` to `batched` are not in `parts` yet. */
  let batch: Uint8Array | undefined;
  let batched = 0;
  let cut = 0;
  /** The thread holding this stream's state, once a batch went to it. */
  let owner: Sha256Thread | undefined;
  let freed = false;
  const token = {};

  const release = () => {
    if (!owner) return;
    const held = owner;
    owner = undefined;
    held.streams--;
    if (held === thread) held.worker.postMessage({ op: 'free', id } satisfies Sha256WorkerRequest);
    releaseThread(held);
  };

  /** Moves the batch's bytes not yet in `parts` there. */
  const cutBatch = () => {
    if (!batch || batched === cut) return;
    parts.push(batch.subarray(cut, batched));
    partsLength += batched - cut;
    cut = batched;
  };

  const flush = () => {
    cutBatch();
    if (parts.length === 0) return;
    if (!owner) {
      owner = sha256Thread();
      owner.streams++;
      unfreed.register(stream, release, token);
    }
    const batches = batch ? [...outgrown, batch.buffer as ArrayBuffer] : outgrown;
    owner.worker.postMessage({ op: 'update', id, data: parts, batches } satisfies Sha256WorkerRequest, [...batches, ...given]);
    parts = [];
    partsLength = 0;
    given = [];
    outgrown = [];
    batch = undefined;
    batched = 0;
    cut = 0;
  };

  const copy = (chunk: Uint8Array) => {
    for (let offset = 0; offset < chunk.length;) {
      // The first batch grows to what it holds, so a small file costs a small copy.
      const want = batched + chunk.length - offset;
      if (!batch || (batch.length < want && batch.length < STREAM_BATCH)) {
        const size = owner ? STREAM_BATCH : Math.min(STREAM_BATCH, Math.max(want - cut, 2 * (batch?.length ?? 0), 16 * 1024));
        const spare = size === STREAM_BATCH ? spareBatches.pop() : undefined;
        const grown = spare ? new Uint8Array(spare) : new Uint8Array(size);
        if (batch) {
          grown.set(batch.subarray(cut, batched));
          if (cut > 0) outgrown.push(batch.buffer as ArrayBuffer);
          batched -= cut;
          cut = 0;
        }
        batch = grown;
      }
      const take = Math.min(batch.length - batched, chunk.length - offset);
      batch.set(chunk.subarray(offset, offset + take), batched);
      batched += take;
      offset += take;
      if (batched === STREAM_BATCH || partsLength + batched - cut >= STREAM_BATCH) flush();
    }
  };

  const stream: Sha256Stream = {
    update(chunk, transfer) {
      if (!transfer || !(chunk.buffer instanceof ArrayBuffer)) return copy(chunk);
      if (chunk.length === 0) return;
      cutBatch();
      parts.push(chunk);
      partsLength += chunk.length;
      if (!given.includes(chunk.buffer)) given.push(chunk.buffer);
      if (partsLength >= STREAM_BATCH) flush();
    },
    peekHex() {
      if (freed) return Promise.reject(new Error('the sha256 stream was freed'));
      if (!owner) {
        const hash = createHash('sha256');
        for (const part of parts) hash.update(part);
        if (batch) hash.update(batch.subarray(cut, batched));
        return Promise.resolve(hash.digest('hex'));
      }
      flush();
      const current = owner;
      if (current !== thread) return Promise.reject(new Error('the sha256 thread that held this stream is gone'));
      const seq = current.nextSeq++;
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      current.replies.set(seq, { resolve, reject });
      current.worker.postMessage({ op: 'peek', id, seq } satisfies Sha256WorkerRequest);
      return promise;
    },
    free() {
      if (freed) return;
      freed = true;
      parts = [];
      partsLength = 0;
      given = [];
      outgrown = [];
      batch = undefined;
      batched = 0;
      cut = 0;
      unfreed.unregister(token);
      release();
    },
  };
  return stream;
};
