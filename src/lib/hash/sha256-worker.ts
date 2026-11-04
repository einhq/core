/**
 * The thread `createSha256Stream` hashes on: one SHA-256 state per stream id,
 * fed the batches the streams post, in order. Each batch's buffer goes back
 * once hashed, to be filled again.
 */

import { createHash, type Hash } from 'node:crypto';

export type Sha256WorkerRequest =
  | { op: 'update'; id: number; data: Uint8Array }
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
    case 'update':
      hashOf(request.id).update(request.data);
      scope.postMessage({ buffer: request.data.buffer as ArrayBuffer }, [request.data.buffer as ArrayBuffer]);
      break;
    case 'peek':
      scope.postMessage({ seq: request.seq, hex: hashOf(request.id).copy().digest('hex') });
      break;
    case 'free':
      hashes.delete(request.id);
      break;
  }
};
