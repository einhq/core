/**
 * Who a postgres connection is being acquired for.
 *
 * The pool is one queue shared by two populations with very different
 * expectations. A crawl step does not care whether its next `getNode` runs now
 * or in 400 ms; a person watching a search box completing as they type cares
 * about exactly that. `node-postgres` hands connections out first-come-first-
 * served, which is right only while every waiter is equal — and under a crawl
 * they are not.
 *
 * `PriorityPool` reads this to keep some of the pool reachable by interactive
 * work. Nothing else should need it.
 *
 * ## Unbound means interactive
 *
 * The default is deliberately the permissive one. A context nobody tagged
 * behaves as if there were no reservation, so the cost of a missed tag is that
 * the reservation does not apply there — not that a user's keystroke goes
 * behind the crawl, which is what it prevents. Background is therefore opt-in
 * and declared (`workClass` in a service's `config.json`), never inferred.
 *
 * ## Why AsyncLocalStorage
 *
 * The alternative is threading a work class through `NodeVFS` -> `NodeStore` ->
 * every registry, which touches every signature in `src/vfs/` to carry
 * something none of them care about. This keeps it at the two ends: set once at
 * the entry point, read once in `connect()`.
 *
 * In Deno the store survives a deep `await` chain and a timer scheduled inside
 * the context (`priority-pool.test.ts` pins that), and a `Deno.serve`
 * handler does *not* inherit the store from the context that called `serve()`.
 * That last one matters — it means HTTP request handling cannot be mis-tagged
 * by whatever the http-server service is doing around its `serve()` call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type PgWorkClass = 'interactive' | 'background';

const storage = new AsyncLocalStorage<PgWorkClass>();

/**
 * Run `fn` — and everything that awaits out of it — as background work.
 *
 * Applied to a whole service script rather than to individual queries: the
 * crawl's postgres traffic is spread across the engine, the pool workers and
 * every command they invoke, and tagging the root is the only placement that
 * does not need revisiting each time one of them grows a new call path.
 */
export const runAsBackground = <T>(fn: () => T): T => storage.run('background', fn);

/** The class of the calling context; `interactive` when nothing set one. */
export const currentWorkClass = (): PgWorkClass => storage.getStore() ?? 'interactive';
