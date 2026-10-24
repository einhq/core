/**
 * Routing key matching, in one place, for both backends.
 *
 * Keys are dot-delimited (`system.vfs.<nodeType>.<eventType>`, `media.file.discovered`), so
 * bindings use AMQP topic semantics over segments:
 *
 * - `*` — exactly one segment. `system.vfs.file.*` matches `system.vfs.file.created`, not
 *   `system.vfs.file` and not `system.vfs.file.a.b`.
 * - `#` — zero or more segments. `media.#` matches `media`, `media.file` and
 *   `media.file.discovered`; a lone `#` matches everything.
 *
 * A wildcard is only a wildcard as a **whole** segment: `*ed` and `a#b` are literals, so a key that
 * happens to contain those characters still matches itself.
 *
 * ## Why the semantics live here and only here
 *
 * The memory registries match in JS; the PostgreSQL ones match in SQL. Translating globs on both
 * sides would be two implementations of the same rules, drifting the first time one is touched, and
 * the failure mode is silent — a delivery that simply does not happen. So the pattern is compiled
 * to a regex **source string here**, and the PG registries store that string and hand it to
 * `~ ANY(...)`. Postgres AREs and JS RegExp agree on everything emitted below (`(?:…)`, `[^.]+`,
 * `.*`, backslash-escaped literals), and the shared conformance suites run the same pattern cases
 * against memory and postgres.
 *
 * ## Cost
 *
 * Exact keys stay a `Set` lookup, and a pattern list is normally empty. A binding is not free:
 * `system.vfs.#` subscribes a consumer to every VFS event, which is a choice the consumer makes, not
 * one this module can make for it.
 */

/** Regex metacharacters, escaped identically by JS RegExp and Postgres ARE. */
const escapeLiteral = (segment: string): string => segment.replace(/[.^$+?()[\]{}|\\*]/g, '\\$&');

/** Whether a key binds more than itself, i.e. carries a whole-segment `*` or `#`. */
export const isRoutingPattern = (key: string): boolean => key.split('.').some((segment) => segment === '*' || segment === '#');

/**
 * Compile a pattern to an anchored regex source valid in both JS and Postgres.
 *
 * `#` absorbs the separator next to it rather than sitting between two of them, which is what makes
 * the zero-segment case work: `media.#` has to match bare `media`, and `#.created` bare `created`.
 */
export const routingPatternToRegexSource = (pattern: string): string => {
  const segments = pattern.split('.');
  let out = '';
  // Whether the next literal/`*` segment must be preceded by its own separator. False after a
  // leading `#`, which emits the separator as part of its own repetition.
  let separator = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment === '#') {
      if (i === 0) {
        out += segments.length === 1 ? '.*' : '(?:[^.]+\\.)*';
        separator = false;
      } else {
        out += '(?:\\.[^.]+)*';
        separator = true;
      }

      continue;
    }

    if (separator) {
      out += '\\.';
    }

    out += segment === '*' ? '[^.]+' : escapeLiteral(segment);
    separator = true;
  }

  return `^${out}$`;
};

/** Compiled patterns, keyed by pattern. Bindings change rarely and the set is tiny. */
const compiled = new Map<string, RegExp>();

/**
 * The compiled form of one pattern, cached.
 *
 * For callers that keep their own pattern→something association (readers waiting on a pattern),
 * which `compileRoutingKeys` flattens away.
 */
export const routingPatternRegex = (pattern: string): RegExp => {
  let regex = compiled.get(pattern);

  if (!regex) {
    regex = new RegExp(routingPatternToRegexSource(pattern));
    compiled.set(pattern, regex);
  }

  return regex;
};

/** A bound key list split into the two things matching actually needs. */
export type CompiledRoutingKeys = {
  /** Keys that match only themselves. */
  exact: Set<string>;
  /** Compiled wildcard bindings. Empty on a system that uses none — the common case. */
  patterns: RegExp[];
};

/** Split a bound key list into an exact set and compiled patterns. */
export const compileRoutingKeys = (keys: Iterable<string>): CompiledRoutingKeys => {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  for (const key of keys) {
    if (isRoutingPattern(key)) {
      patterns.push(routingPatternRegex(key));
    } else {
      exact.add(key);
    }
  }

  return { exact, patterns };
};

/** Whether a compiled binding list matches a published key. */
export const compiledKeysMatch = ({ exact, patterns }: CompiledRoutingKeys, routingKey: string): boolean => {
  if (exact.has(routingKey)) {
    return true;
  }

  for (const pattern of patterns) {
    if (pattern.test(routingKey)) {
      return true;
    }
  }

  return false;
};

/**
 * Whether any of `keys` — exact or pattern — matches a published key.
 *
 * For the memory registries, which hold their bindings as plain arrays and re-check a handful of
 * them per event. Exact keys never build a regex.
 */
export const routingKeysMatch = (keys: readonly string[], routingKey: string): boolean => {
  for (const key of keys) {
    if (key === routingKey) {
      return true;
    }

    if (isRoutingPattern(key) && routingPatternRegex(key).test(routingKey)) {
      return true;
    }
  }

  return false;
};

/**
 * The regex sources a binding list contributes, for the `routing_patterns` column.
 *
 * Exact keys contribute nothing: they are matched by the indexed `routing_keys` branch, and
 * duplicating them as regexes would move the common case onto the scan.
 */
export const routingPatternSources = (keys: readonly string[]): string[] => keys.filter(isRoutingPattern).map(routingPatternToRegexSource);
