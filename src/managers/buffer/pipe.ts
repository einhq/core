/**
 * Pipe models a Linux-like pipe:
 * - fixed capacity in bytes
 * - async read/write with backpressure
 * - ordering guaranteed
 * - close/EOF signaling
 * - a write to a pipe nothing reads any more fails, as SIGPIPE ends a writer
 *
 * `capacity` is a ceiling, not an allocation. The backing store starts empty
 * and doubles up to `capacity` as a writer outruns its reader, then is released
 * again once the pipe is closed and drained. Every command gets a stdout and a
 * stderr pipe and most emit a line or two, so a pipe holds only what it needs.
 * See ein/core#82.
 */

import { BrokenPipeError } from '@ein/bash-executor';

/** Shared backing store for pipes holding nothing. Never written to. */
const EMPTY = new Uint8Array(0);

/** First allocation once a pipe is actually written to, capped by its capacity. */
const INITIAL_ALLOCATION = 1024;

export class Pipe {
  private buffer: Uint8Array = EMPTY;
  private readPos = 0;
  private writePos = 0;
  private _closed = false;
  private _unread = false;
  private _size = 0;
  private _capacity = 0;

  private writeWaiters: Array<() => void> = [];
  private readWaiters: Array<() => void> = [];

  /** Create a pipe with the given capacity in bytes. Zero capacity discards writes. */
  constructor(
    capacity?: number,
  ) {
    this._capacity = capacity || 0;
  }

  /** Number of bytes currently buffered and available for reading. */
  get size(): number {
    return this._size;
  }

  /** Total buffer capacity in bytes. */
  get capacity(): number {
    return this._capacity;
  }

  /** Bytes currently allocated for the backing store, at most {@link capacity}. */
  get allocated(): number {
    return this.buffer.length;
  }

  /** Whether the pipe has been closed for writing. */
  get closed(): boolean {
    return this._closed;
  }

  /** Whether the pipe has been closed for reading: nothing reads it any more. */
  get unread(): boolean {
    return this._unread;
  }

  /**
   * Grow the backing store so it holds at least `needed` bytes, up to capacity.
   * Buffered bytes are linearized to offset 0, which is why the wrap arithmetic
   * below reads `this.buffer.length` rather than the capacity.
   */
  private grow(needed: number): void {
    const current = this.buffer.length;

    if (current >= this._capacity) {
      return;
    }

    let next = current === 0 ? Math.min(INITIAL_ALLOCATION, this._capacity) : current;

    while (next < needed && next < this._capacity) {
      next *= 2;
    }

    next = Math.min(next, this._capacity);

    if (next <= current) {
      return;
    }

    const grown = new Uint8Array(next);

    if (this._size > 0) {
      const end = this.readPos + this._size;

      if (end <= current) {
        grown.set(this.buffer.subarray(this.readPos, end));
      } else {
        const firstPart = current - this.readPos;
        grown.set(this.buffer.subarray(this.readPos, current));
        grown.set(this.buffer.subarray(0, this._size - firstPart), firstPart);
      }
    }

    this.readPos = 0;
    this.writePos = this._size % next;
    this.buffer = grown;
  }

  /**
   * Hand the backing store back once nothing can be read from it again. A
   * closed, drained pipe still lives in the buffer registry until its owner
   * removes it, and until then it has no reason to hold on to its bytes.
   */
  private release(): void {
    if (this.buffer.length === 0) {
      return;
    }

    this.buffer = EMPTY;
    this.readPos = 0;
    this.writePos = 0;
  }

  /** Close the pipe for writing. Readers will receive EOF when buffer is empty. */
  close(): void {
    this._closed = true;

    if (this._size === 0) {
      this.release();
    }

    this.readWaiters.forEach((w) => w());
    this.readWaiters = [];

    // A writer parked on a full pipe wakes to see the closed flag and throw;
    // its reader may already be gone, so nothing else would wake it.
    this.writeWaiters.forEach((w) => w());
    this.writeWaiters = [];
  }

  /**
   * Close the pipe for reading: what is in it is dropped, and a write, waiting
   * or to come, throws a `BrokenPipeError`.
   */
  closeRead(): void {
    this._unread = true;
    this._size = 0;
    this.release();

    this.writeWaiters.forEach((w) => w());
    this.writeWaiters = [];
  }

  /** Write bytes. Waits while the pipe is full. Throws if closed, for writing or for reading. */
  async write(data: Uint8Array): Promise<number> {
    if (this._unread) {
      throw new BrokenPipeError();
    }

    if (this._closed) {
      throw new Error('pipe is closed');
    }

    if (this._capacity === 0) {
      return data.length;
    }

    let offset = 0;

    while (offset < data.length) {
      if (this._unread) {
        throw new BrokenPipeError();
      }

      if (this._closed) {
        throw new Error('pipe has closed');
      }

      // Only grow for bytes that have nowhere to go: a reader keeping up with a
      // chatty command leaves the pipe at its first allocation forever.
      if (this._size === this.buffer.length) {
        this.grow(this._size + (data.length - offset));
      }

      if (this._size === this._capacity) {
        await new Promise<void>((res) => this.writeWaiters.push(res));
        continue;
      }

      const allocated = this.buffer.length;
      const space = allocated - this._size;
      const toWrite = Math.min(space, data.length - offset);

      const end = this.writePos + toWrite;

      if (end <= allocated) {
        this.buffer.set(
          data.subarray(offset, offset + toWrite),
          this.writePos,
        );
      } else {
        const firstPart = allocated - this.writePos;
        this.buffer.set(
          data.subarray(offset, offset + firstPart),
          this.writePos,
        );
        const remaining = toWrite - firstPart;
        this.buffer.set(
          data.subarray(offset + firstPart, offset + firstPart + remaining),
          0,
        );
      }

      this.writePos = (this.writePos + toWrite) % allocated;
      this._size += toWrite;
      offset += toWrite;

      this.readWaiters.forEach((w) => w());
      this.readWaiters = [];
    }

    return offset;
  }

  private async waitWithAbort(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        const idx = this.readWaiters.indexOf(waiter);
        if (idx !== -1) {
          this.readWaiters.splice(idx, 1);
        }

        reject(signal!.reason);
      };

      this.readWaiters.push(waiter);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Read up to size; waits if empty. Returns empty on EOF. */
  async read(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this._capacity === 0) {
      return new Uint8Array(0);
    }

    if (this._closed && this._size === 0) {
      return new Uint8Array(0);
    }

    while (this._size === 0) {
      if (this._closed) {
        return new Uint8Array(0);
      }

      await this.waitWithAbort(signal);
    }

    const allocated = this.buffer.length;
    const toRead = Math.min(size, this._size);
    const end = this.readPos + toRead;
    const out = new Uint8Array(toRead);

    if (end <= allocated) {
      out.set(this.buffer.subarray(this.readPos, this.readPos + toRead));
    } else {
      const firstPart = allocated - this.readPos;
      out.set(this.buffer.subarray(this.readPos, allocated));
      const remaining = toRead - firstPart;
      out.set(this.buffer.subarray(0, remaining), firstPart);
    }

    this.readPos = (this.readPos + toRead) % allocated;
    this._size -= toRead;

    // Nothing more can arrive and nothing is left: give the bytes back rather
    // than hold them until whoever owns the pipe gets around to deleting it.
    if (this._size === 0 && this._closed) {
      this.release();
    }

    this.writeWaiters.forEach((w) => w());
    this.writeWaiters = [];

    return out;
  }
}
