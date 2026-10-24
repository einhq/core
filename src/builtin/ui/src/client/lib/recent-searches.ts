/** A search someone ran on the Search page: its URL parameters, and how to name it. */
export type RecentSearch = { params: string; label: string };

/** How many recent searches the Search page keeps. */
export const RECENT_SEARCHES = 8;

/** Put `entry` first, dropping an earlier run of the same parameters, and keep at most `max`. */
export function rememberSearch(list: readonly RecentSearch[], entry: RecentSearch, max = RECENT_SEARCHES): RecentSearch[] {
  if (!entry.params || !entry.label.trim()) return [...list];
  return [entry, ...list.filter((recent) => recent.params !== entry.params)].slice(0, max);
}

/** The list without the search for `params`. */
export function forgetSearch(list: readonly RecentSearch[], params: string): RecentSearch[] {
  return list.filter((recent) => recent.params !== params);
}

/** What browser storage held, as a list of recent searches; anything that is not one is dropped. */
export function recentSearchesFrom(stored: unknown): RecentSearch[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is RecentSearch => typeof entry === 'object' && entry !== null && typeof entry.params === 'string' && typeof entry.label === 'string')
    .slice(0, RECENT_SEARCHES);
}
