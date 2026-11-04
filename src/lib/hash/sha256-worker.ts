/**
 * The thread `createSha256Stream` hashes on: one SHA-256 state per stream id,
 * fed the bytes the streams post, in order. The buffers of the batches they
 * were copied into go back once hashed, to be filled again. Buffers a stream
 * was handed are freed at once: left to this thread's garbage collector, which
 * seldom runs here, their memory would not be there for the main thread to
 * allocate again, and fresh pages cost it more.
 */

import { createHash, type Hash } from 'node:crypto';

export type Sha256WorkerRequest =
  /** `data` in order; `batches` are the copy batches among their buffers, to be given back. */
  | { op: 'update'; id: number; data: Uint8Array[]; batches: ArrayBuffer[] }
  | { op: 'peek'; id: number; seq: number }
  | { op: 'free'; id: number };

export type Sha256WorkerReply = { seq: number; hex: string } | { buffer: ArrayBuffer };

const hashes = new Map<number, Hash>();

const hashOf = (id: number): Hash => {
  let hash = hashes.get(id);
  if (!hash) {
    hash = createHash('sha256');
    hashes.set(id, hash);
  }
  return hash;
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Sha256WorkerRequest>) => void) | null;
  postMessage(reply: Sha256WorkerReply, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data: request }) => {
  switch (request.op) {
    case 'update': {
      const hash = hashOf(request.id);
      for (const part of request.data) hash.update(part);
      for (const buffer of request.batches) scope.postMessage({ buffer }, [buffer]);
      for (const part of request.data) {
        if (part.buffer.byteLength > 0) (part.buffer as ArrayBuffer).transfer(0);
      }
      break;
    }
    case 'peek':
      scope.postMessage({ seq: request.seq, hex: hashOf(request.id).copy().digest('hex') });
      break;
    case 'free':
      hashes.delete(request.id);
      break;
  }
};
