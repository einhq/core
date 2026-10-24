import { assert, assertEquals, assertRejects } from '@std/assert';
import { createMediaSetCache, type MediaSet } from '../media-set.ts';
import { mediaItemFrom } from '../media-item.ts';

/** A loader the test answers by hand: each call waits until `answer(path)` or `fail(path)`. */
const manualLoader = () => {
  const pending = new Map<string, { resolve: (set: MediaSet) => void; reject: (error: unknown) => void; signal: AbortSignal }>();
  const calls: string[] = [];
  const loader = (path: string, signal: AbortSignal) => {
    calls.push(path);
    return new Promise<MediaSet>((resolve, reject) => {
      pending.set(path, { resolve, reject, signal });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  const setOf = (path: string): MediaSet => ({ items: [mediaItemFrom({ path: `${path}/a.jpg` })], truncated: false });
  return {
    loader,
    calls,
    pending,
    answer: async (path: string) => {
      pending.get(path)!.resolve(setOf(path));
      pending.delete(path);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test('a kept set is answered without fetching again, and the least recently used one goes first', async () => {
  const fake = manualLoader();
  const cache = createMediaSetCache(fake.loader, { capacity: 2 });
  for (const path of ['/g/a', '/g/b']) {
    const loading = cache.load(path);
    await fake.answer(path);
    await loading;
  }
  // Touch /g/a, so /g/b is the least recently used when /g/c arrives.
  await cache.load('/g/a');
  const loading = cache.load('/g/c');
  await fake.answer('/g/c');
  await loading;
  await settle();

  assertEquals(fake.calls, ['/g/a', '/g/b', '/g/c']);
  assert(cache.peek('/g/a'));
  assertEquals(cache.peek('/g/b'), undefined);
  assert(cache.peek('/g/c'));
});

Deno.test('two calls for one set share one fetch', async () => {
  const fake = manualLoader();
  const cache = createMediaSetCache(fake.loader);
  const first = cache.load('/g/a');
  const second = cache.load('/g/a');
  await fake.answer('/g/a');
  assertEquals((await first).items[0].path, '/g/a/a.jpg');
  assertEquals(await first, await second);
  assertEquals(fake.calls, ['/g/a']);
});

Deno.test('a forgotten set is asked for again, and a fetch running when it was forgotten is not kept', async () => {
  const fake = manualLoader();
  const cache = createMediaSetCache(fake.loader);
  const loading = cache.load('/g/a');
  cache.forget('/g/a');
  await fake.answer('/g/a');
  await loading;
  await settle();
  assertEquals(cache.peek('/g/a'), undefined);

  const again = cache.load('/g/a');
  await fake.answer('/g/a');
  await again;
  await settle();
  assert(cache.peek('/g/a'));
  cache.forget('/g/a');
  assertEquals(cache.peek('/g/a'), undefined);
  assertEquals(fake.calls, ['/g/a', '/g/a']);
});

Deno.test('a fetch every caller gave up on is aborted and caches nothing', async () => {
  const fake = manualLoader();
  const cache = createMediaSetCache(fake.loader);
  const one = new AbortController();
  const two = new AbortController();
  const first = cache.load('/g/a', { signal: one.signal });
  const second = cache.load('/g/a', { signal: two.signal });

  one.abort();
  await assertRejects(() => first);
  // Somebody still waits, so the fetch goes on.
  assertEquals(fake.pending.get('/g/a')!.signal.aborted, false);

  two.abort();
  await assertRejects(() => second);
  assertEquals(fake.pending.get('/g/a')!.signal.aborted, true);
  await settle();
  assertEquals(cache.peek('/g/a'), undefined);
});

Deno.test('at most the cap is fetched at once; the rest start as those finish, in the order asked', async () => {
  const fake = manualLoader();
  const cache = createMediaSetCache(fake.loader, { maxInFlight: 2 });
  const loads = ['/g/a', '/g/b', '/g/c', '/g/d'].map((path) => cache.load(path));
  assertEquals(fake.calls, ['/g/a', '/g/b']);

  await fake.answer('/g/b');
  await settle();
  assertEquals(fake.calls, ['/g/a', '/g/b', '/g/c']);

  // One waiting that nobody wants any more never starts.
  const unwanted = new AbortController();
  const late = cache.load('/g/e', { signal: unwanted.signal });
  unwanted.abort();
  await assertRejects(() => late);

  await fake.answer('/g/a');
  await settle();
  await fake.answer('/g/c');
  await settle();
  await fake.answer('/g/d');
  await Promise.all(loads);
  assertEquals(fake.calls, ['/g/a', '/g/b', '/g/c', '/g/d']);
});
