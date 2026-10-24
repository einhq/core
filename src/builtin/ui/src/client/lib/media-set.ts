/**
 * The media of one container, laid out whole, kept for the next time it is shown.
 *
 * A page that shows many small containers one after another — the groups of a stream, each a
 * section that settles in view — asks for each one's complete layout once. The sets are kept in a
 * small LRU, so stepping back to a section paints at once, and a set that is about to be shown can
 * be asked for ahead (`prefetchMediaSet`). At most a few are fetched at a time, on this cache's
 * own budget, so a fling past many sections does not queue behind the album covers' requests.
 */

import type { SearchLayoutResponse } from '@ein/api';
import type { MediaItem } from '../signals/album.ts';
import { execCommand } from '../signals/shell-client.ts';
import { mediaItemFrom } from './media-item.ts';
import { decodeSearchLayout } from './search-layout.ts';
import { shq } from './shquote.ts';

/** One container's media in time order, each saying whether it has renditions yet. */
export type MediaSet = {
  items: MediaItem[];
  /** Too large to lay out at once (`search --layout` answered `truncated`): page it instead. */
  truncated: boolean;
};

/** Fetches one set; aborting `signal` gives up on it. */
type MediaSetLoader = (path: string, signal: AbortSignal) => Promise<MediaSet>;

type MediaSetCache = {
  /** The set of `path`, from the cache or fetched. Aborting `signal` rejects this call only; the fetch stops once nobody waits for it. */
  load(path: string, opts?: { signal?: AbortSignal }): Promise<MediaSet>;
  /** `load` for a set about to be shown, whose answer nobody awaits. */
  prefetch(path: string, opts?: { signal?: AbortSignal }): void;
  /** Drop what is kept for `path`, and let a fetch already running for it finish uncached: its members changed. */
  forget(path: string): void;
  /** What is kept for `path`, without fetching. */
  peek(path: string): MediaSet | undefined;
};

type Request = {
  controller: AbortController;
  /** Calls still waiting for it; at 0 it is given up. */
  waiting: number;
  started: boolean;
  promise: Promise<MediaSet>;
  start: () => void;
};

const abortError = (): Error => new DOMException('media set request aborted', 'AbortError');

/**
 * A cache of `capacity` sets, least recently used out first, fetching at most `maxInFlight` at a
 * time through `loader`; the rest wait in the order they were asked for. Two calls for one path
 * share one fetch. A fetch that was given up, failed or was forgotten leaves nothing behind.
 */
export function createMediaSetCache(loader: MediaSetLoader, { capacity = 24, maxInFlight = 4 } = {}): MediaSetCache {
  const kept = new Map<string, MediaSet>();
  const requests = new Map<string, Request>();
  const queue: Request[] = [];
  let running = 0;

  const remember = (path: string, set: MediaSet) => {
    kept.delete(path);
    kept.set(path, set);
    while (kept.size > capacity) kept.delete(kept.keys().next().value!);
  };

  const pump = () => {
    while (running < maxInFlight && queue.length > 0) queue.shift()!.start();
  };

  const requestFor = (path: string): Request => {
    const existing = requests.get(path);
    if (existing) return existing;
    const controller = new AbortController();
    let resolve!: (set: MediaSet) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MediaSet>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nobody may be listening when it fails (the last caller gave up); that is not an error.
    promise.catch(() => {});
    const request: Request = {
      controller,
      waiting: 0,
      started: false,
      promise,
      start: () => {
        request.started = true;
        running++;
        loader(path, controller.signal)
          .then((set) => {
            if (requests.get(path) === request) remember(path, set);
            resolve(set);
          }, reject)
          .finally(() => {
            if (requests.get(path) === request) requests.delete(path);
            running--;
            pump();
          });
      },
    };
    requests.set(path, request);
    queue.push(request);
    pump();
    return request;
  };

  const giveUp = (path: string, request: Request) => {
    if (--request.waiting > 0) return;
    if (requests.get(path) === request) requests.delete(path);
    if (!request.started) {
      const at = queue.indexOf(request);
      if (at >= 0) queue.splice(at, 1);
    }
    request.controller.abort();
  };

  const load = (path: string, { signal }: { signal?: AbortSignal } = {}): Promise<MediaSet> => {
    if (signal?.aborted) return Promise.reject(abortError());
    const cached = kept.get(path);
    if (cached) {
      remember(path, cached);
      return Promise.resolve(cached);
    }
    const request = requestFor(path);
    request.waiting++;
    if (!signal) return request.promise;
    return new Promise<MediaSet>((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        giveUp(path, request);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.promise.then(
        (set) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          resolve(set);
        },
        (error) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };

  return {
    load,
    prefetch: (path, opts) => void load(path, opts).catch(() => {}),
    forget: (path) => {
      kept.delete(path);
      requests.delete(path);
    },
    peek: (path) => kept.get(path),
  };
}

/** A container's media through `search --layout`, oldest first, with whether each has renditions. */
const loadLayout: MediaSetLoader = async (path, signal) => {
  const answer = await execCommand<SearchLayoutResponse>(`search --under ${shq(path)} --sort time --layout --fields derivatives`, { signal });
  if (answer.truncated) return { items: [], truncated: true };
  return { items: decodeSearchLayout(answer.layout).map((row) => mediaItemFrom({ ...row, type: row.kind })), truncated: false };
};

const shared = createMediaSetCache(loadLayout);

/** The media of the container at `path` (an album, a suggested album), oldest first; see `createMediaSetCache`. */
export const loadMediaSet = (path: string, opts?: { signal?: AbortSignal }): Promise<MediaSet> => shared.load(path, opts);

/** Ask for `path`'s media ahead of showing it. */
export const prefetchMediaSet = (path: string, opts?: { signal?: AbortSignal }): void => shared.prefetch(path, opts);

/** Forget `path`'s media, which changed; the next load asks again. */
export const forgetMediaSet = (path: string): void => shared.forget(path);

/** `path`'s media if it is kept, so a section that has it paints in its first frame. */
export const peekMediaSet = (path: string): MediaSet | undefined => shared.peek(path);
