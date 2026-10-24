/**
 * The one timezone this deployment renders and buckets in.
 *
 * Everything is *stored* as an instant — epoch milliseconds on a node's props, a
 * `timestamptz` column, an ISO string with an offset — so none of this decides what a
 * timestamp means. It decides what the archive's owner is shown, and which year a file born
 * late on New Year's Eve counts towards.
 *
 * `TZ` in the environment is what sets it. `Intl` rather than `Deno.env.get('TZ')` on purpose: it
 * resolves an unset `TZ` to the host's zone, which is what a bare `deno task dev` should
 * follow, and it answers with a canonical IANA id either way.
 *
 * Read once. A process does not change zones underneath itself, and the value reaches
 * PostgreSQL's session `TimeZone` at connect time — the two have to be the same string, or
 * the in-memory and pg aggregates disagree about the boundary (`vfs/query-eval.ts`
 * `birthtimeBucket` against `stores/pg/query.ts`'s `to_char`).
 */
export const SYSTEM_TIME_ZONE: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
