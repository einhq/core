import { compiledKeysMatch, type CompiledRoutingKeys, compileRoutingKeys } from './routing-key-match.ts';

/**
 * "Is anything bound to this routing key?" — answered without asking postgres.
 *
 * Every VFS mutation publishes an event, and a registry relaying events would
 * otherwise ask postgres about every one of them. Almost all of those questions
 * are wasted — the routing key space is tiny (`system.vfs.<nodeType>.<eventType>`)
 * and only a handful of keys are ever bound, so `system.vfs.tty.updated`, which
 * a crawl emits constantly, matches nothing.
 *
 * Most bindings are exact keys, so the answer is a `Set` lookup. A binding may also be a wildcard
 * pattern (`system.vfs.file.*`), which cannot live in the set; those are
 * compiled once and tested in a loop that is empty on a system that binds none — the normal case,
 * and the one this cache exists for.
 *
 * ## Why this is safe
 *
 * This is a **negative cache only**. A hit runs the query as if there were no
 * cache; a miss skips a query that would have returned nothing. The only
 * possible defect is a false negative — a key that is bound but missing from the
 * set — which would silently drop a delivery. Every design choice here exists to
 * make that unreachable:
 *
 * - The unloaded state is `undefined`, not an empty set, and answers `true` to
 *   everything. A registry that never loads therefore queries every event
 *   rather than dropping them.
 * - `add()` is called *before* the write that binds the key, so a publish racing
 *   an in-flight subscribe errs toward running the query.
 * - Any failure to refresh drops back to the permissive state.
 * - Removal never subtracts a key; it reloads the whole set from the table, so a
 *   key still held by a sibling subscription cannot be lost to a refcount bug.
 */
export class BoundRoutingKeys {
  /** `undefined` means "not known" and answers yes to everything. Never an empty set by accident. */
  private keys: Set<string> | undefined;
  /** `keys`, split into an exact set and compiled patterns. Rebuilt only when `keys` changes. */
  private compiled: CompiledRoutingKeys = compileRoutingKeys([]);
  private inFlight: Promise<void> | undefined;
  private pending = false;

  /**
   * @param load Reads the currently bound keys from the source of truth. Any
   *             throw leaves the cache permissive.
   */
  constructor(private readonly load: () => Promise<string[]>) {}

  /**
   * True when the key may be bound. Deliberately biased: unknown means yes.
   */
  has(routingKey: string): boolean {
    return this.keys === undefined || compiledKeysMatch(this.compiled, routingKey);
  }

  /** Whether the set has been loaded — for tests and diagnostics. */
  get loaded(): boolean {
    return this.keys !== undefined;
  }

  /**
   * Widen the set ahead of a write that will bind these keys.
   *
   * Called before the INSERT rather than after, so an event published while the
   * write is in flight still reaches postgres. Over-inclusion costs one query;
   * under-inclusion loses a message.
   */
  add(routingKeys: readonly string[]): void {
    if (this.keys === undefined || routingKeys.length === 0) {
      return;
    }

    let added = false;

    for (const key of routingKeys) {
      if (!this.keys.has(key)) {
        this.keys.add(key);
        added = true;
      }
    }

    // Recompiled rather than appended to, so a repeated `add` of the same pattern cannot grow the
    // list it is tested against. Bindings change a handful of times per boot.
    if (added) {
      this.compiled = compileRoutingKeys(this.keys);
    }
  }

  /** Forget everything and answer yes until the next successful refresh. */
  invalidate(): void {
    this.keys = undefined;
  }

  /**
   * Reload from the source of truth.
   *
   * Concurrent calls coalesce, and a call arriving while a load is running sets
   * a flag so the result of *that* load is not treated as current — a NOTIFY
   * that lands mid-query would otherwise be swallowed by the in-flight read that
   * started before the change committed.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return await this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        do {
          this.pending = false;
          const keys = await this.load();
          if (!this.pending) {
            this.keys = new Set(keys);
            this.compiled = compileRoutingKeys(this.keys);
          }
        } while (this.pending);
      } catch {
        // Cannot prove what is bound, so assume everything is. Degrades to a
        // query per event rather than to lost messages.
        this.keys = undefined;
      } finally {
        this.inFlight = undefined;
      }
    })();

    return await this.inFlight;
  }
}
