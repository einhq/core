import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../signals/album.ts';
import type { SearchAppliedFilters, SearchHit } from '@ein/api';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import { mediaItemFrom } from '../lib/media-item.ts';
import { decodeSearchLayout, type SearchLayoutIndex } from '../lib/search-layout.ts';
import { type ScrollRoot, usePrependHold } from './usePrependHold.ts';

// The vocabulary itself lives in lib/, so the URL codec can use it without importing this
// file and, through it, the WebSocket client. Re-exported so `@ein/ui/hooks` stays the one place
// components import search types from.
export { ENTITY_KIND_FILTERS, ENTITY_KINDS, FILE_KINDS, MEDIA_KIND_FILTERS, MEDIA_KINDS, SEARCH_KINDS, SEARCH_SORTS } from '../lib/search-filters.ts';
export type { MediaKindFilter, SearchFilters, SearchKind, SearchRegion, SearchSort } from '../lib/search-filters.ts';

import type { SearchFilters } from '../lib/search-filters.ts';

/** One hit from the `search` command (`@ein/api` `SearchHit`), with the page's own context. */
export type SearchResult = SearchHit & {
  /** Client-only context: the album whose stack manifest collapsed this hit. */
  stackAlbumPath?: string;
};

type SearchResponse = {
  query: string;
  filters?: Pick<SearchAppliedFilters, 'subjects'>;
  /**
   * The answer is a prefix of the real one — the scan limit was hit, or a text
   * search filled its provider page. Either way the count shown is a floor.
   */
  truncated: boolean;
  cursor: string | null;
  /**
   * Where this page starts in the answer.
   *
   * Only the sources that page by position — a subject, an album —
   * report a meaningful one, and it is what walking back up subtracts from.
   */
  offset?: number;
  /**
   * Resume token positioned at the top of this page, for the time-ordered browse
   * that pages by key rather than position — `--above` hands back the page
   * above it. Null once nothing is left above.
   */
  above?: string | null;
  /** How many leading results sit above a seek — the page's lead. 0 when it starts where asked. */
  anchorIndex?: number;
  results?: SearchResult[];
  /** Present for `--layout`: the complete compact media metadata index. */
  layout?: SearchLayoutIndex;
  /** Wall time the command took on the server. */
  elapsedMs?: number;
  /** What the providers said on stderr — a content match that timed out, say. Each degrades the answer. */
  warnings?: string[];
};

/** How the first page of the current search was answered. */
export type SearchOutcome = {
  /** From issuing the command to its answer arriving, as seen from the browser. */
  clientMs: number;
  /** The command's own wall time, when it reported one. */
  serverMs?: number;
  /** Provider warnings; non-empty means the page is not the complete answer it looks like. */
  warnings: string[];
  /** Each `subjects` filter asked for (`person:anna`, or a path), with the node it resolved to. */
  subjects: { ref: string; path: string }[];
};

type UseSearchOptions = SearchFilters & {
  limit?: number;
  debounce?: number;
  /** Skip searching entirely — used by the header spotlight when it is closed. */
  enabled?: boolean;
  /**
   * Search even with no filter at all: the newest-first browse of everything.
   * Off by default, because for every other caller an empty filter set means
   * nothing has been asked yet.
   */
  browseAll?: boolean;
  /**
   * Start the list at this truncated ISO date (`YYYY`, `YYYY-MM`, or
   * `YYYY-MM-DD`) instead of at the newest — where the time scrubber moved.
   *
   * Only the position-paged sources (`--subject`, `--under`) can honour
   * it, because only they have an order to take a position in.
   */
  anchor?: string | null;
  /**
   * The element the list scrolls in, when it is not the page. Used to hold the
   * reader's location while pages arrive above them.
   */
  scrollRoot?: ScrollRoot;
  /**
   * Fetch one complete compact index — of a container, a subject or a subtree — instead of cursor
   * pages. One too large to send at once is paged instead.
   */
  layout?: boolean;
};

export type UseSearchResult = {
  results: SearchResult[];
  loading: boolean;
  error: Error | null;
  /** Present when more results exist; call `loadMore` to append the next page. */
  hasMore: boolean;
  loadMore: () => void;
  /**
   * Drop results by path, for hits that no longer exist. Re-running the search would
   * reset the cursor and throw away every page loaded so far, so deletion prunes the
   * list in place instead.
   */
  removeResults: (paths: string[]) => void;
  /**
   * Re-run the search from the first page, discarding what is loaded.
   *
   * `removeResults` covers a hit that no longer exists, but not one whose *ordering* changed —
   * a bulk retime moves media between date buckets, and only a refetch can show that.
   */
  reload: () => void;
  /** True while the anchor has left something newer above the top of the list. */
  hasNewer: boolean;
  /**
   * Where a seeked list actually starts: the index of the first result at the
   * anchor, after the lead the server sent above it. 0 for every other list.
   */
  anchorIndex: number;
  /**
   * The anchor the current results answer — `null` for the top — so a caller
   * can tell a sought page from the previous list still on screen while it
   * loads. Set when a fresh page lands, never while one is in flight.
   */
  answeredAnchor: string | null;
  /** Attach to an element above the first result to page upward on scroll. */
  topSentinelRef: (node: HTMLElement | null) => void;
  /**
   * Paths where a page was prepended — the first result of the list as it stood
   * before it grew. A grid must not re-pack across one of these.
   */
  seams: ReadonlySet<string>;
  /** How the first page was answered — timing and provider warnings. Null until one has. */
  outcome: SearchOutcome | null;
};

/** The shell command for a filter set. */
export function buildSearchCommand(
  filters: SearchFilters,
  limit: number,
  cursor?: string,
  anchor?: string | null,
  layout = false,
  above?: string,
): string {
  const parts = ['search'];

  if (filters.query?.trim()) parts.push(shq(filters.query.trim()));
  parts.push('-l', String(limit));
  // Result cards render `description` (albums, people, locations).
  parts.push('--fields', 'description');
  if (filters.kinds?.length) parts.push('--kind', filters.kinds.join(','));
  for (const tag of filters.tags ?? []) parts.push('--tag', shq(tag));
  if (filters.fromYear !== undefined) parts.push('--from', String(filters.fromYear));
  // The command's --to is exclusive per bucket, so a year bound includes that year.
  if (filters.toYear !== undefined) parts.push('--to', String(filters.toYear));
  // Repeated rather than comma-joined: the command intersects the subjects it is given, so
  // `--subject person:a --subject person:b` is "both of them in the picture".
  for (const subject of filters.subjects ?? []) parts.push('--subject', shq(subject));
  for (const name of filters.subjectNames ?? []) parts.push('--subject-name', shq(name));
  if (filters.under) parts.push('--under', shq(filters.under));
  if (filters.within) parts.push('--within', shq(filters.within));
  for (const name of filters.missing ?? []) parts.push('--missing', shq(name));
  if (filters.like) parts.push('--like', shq(filters.like));
  if (filters.creator !== undefined) parts.push('--creator', String(filters.creator));
  if (filters.sort) parts.push('--sort', filters.sort);

  const region = filters.region;
  if (region?.shape === 'bbox') {
    parts.push('--bbox', `${region.north},${region.south},${region.east},${region.west}`);
  } else if (region?.shape === 'circle') {
    parts.push('--circle', `${region.lat},${region.lng},${region.radius}`);
  } else if (region?.shape === 'polygon') {
    parts.push('--polygon', shq(region.points.map((p) => `${p.lat},${p.lng}`).join(';')));
  }

  if (layout) parts.push('--layout');
  else if (above) parts.push('--above', shq(above));
  else if (cursor) parts.push('--cursor', shq(cursor));
  // A position and a date are two ways of saying where to start; the command
  // rejects both at once, so the cursor wins once paging has begun.
  else if (anchor) parts.push('--at', shq(anchor));

  return parts.join(' ');
}

/** True when a filter set would actually constrain anything. */
export function hasAnyFilter(filters: SearchFilters): boolean {
  return Boolean(
    filters.query?.trim() ||
      filters.kinds?.length ||
      filters.tags?.length ||
      filters.fromYear !== undefined ||
      filters.toYear !== undefined ||
      filters.region ||
      filters.subjects?.length ||
      filters.subjectNames?.length ||
      filters.under ||
      filters.within ||
      filters.missing?.length ||
      filters.like ||
      filters.creator !== undefined,
  );
}

/** A search hit rendered as a lightbox-ready media item. */
export function searchResultToMediaItem(result: SearchResult): MediaItem {
  // `kind` is the search command's own classification and outranks the mimetype.
  return mediaItemFrom({
    ...result,
    type: result.kind === 'video' ? 'video' : result.kind === 'audio' ? 'audio' : 'photo',
    score: result.score,
  });
}

/**
 * Faceted search over the shell `search` command.
 *
 * Any subset of filters is a valid query — a year range or a kind alone works
 * without text. Responses are dropped when a newer request has started
 * (`generationRef`): several controls can move at once. The superseded command
 * is also hung up on the server (`abortRef`), so it stops instead of finishing
 * work for an answer nobody reads.
 */
export function useSearch(opts: UseSearchOptions): UseSearchResult {
  const { limit = 60, debounce = 0, enabled = true, browseAll = false, anchor = null, scrollRoot = null, layout = false, ...filters } = opts;

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  /** Where the loaded list starts in the answer. Above zero is media out of reach above it. */
  const [topOffset, setTopOffset] = useState(0);
  /** The keyset counterpart: a token for the page above, while the server says there is one. */
  const [aboveCursor, setAboveCursor] = useState<string | null>(null);
  const [anchorIndex, setAnchorIndex] = useState(0);
  const [answeredAnchor, setAnsweredAnchor] = useState<string | null>(null);
  const [seams, setSeams] = useState<ReadonlySet<string>>(() => new Set());
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  // Bumped by `reload`; the main effect depends on it, so the search re-runs unchanged.
  const [reloadKey, setReloadKey] = useState(0);

  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  /** The running search's commands, pages included; a new search or a reset aborts it. */
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const previousQueryRef = useRef<string | undefined>(undefined);
  const previousAnchorRef = useRef<string | null>(anchor);
  /** An over-limit layout falls back to the existing cursor path. */
  const layoutFallbackRef = useRef(false);
  /** The list as it stands, readable outside a render — a prepend has to diff against it. */
  const resultsRef = useRef<SearchResult[]>([]);
  const hold = usePrependHold(results, scrollRoot);
  // Filters are compared by value: they arrive as fresh objects every render.
  const filterKey = JSON.stringify(filters);

  const setList = useCallback((next: SearchResult[]) => {
    resultsRef.current = next;
    setResults(next);
  }, []);

  const run = useCallback(async (parsed: SearchFilters, mode: 'fresh' | 'append' | 'prepend', from?: string, preserve = false, above?: string) => {
    const generation = mode === 'fresh' ? ++generationRef.current : generationRef.current;
    if (mode === 'fresh' || !abortRef.current) {
      abortRef.current?.abort();
      abortRef.current = new AbortController();
    }
    const { signal } = abortRef.current;
    loadingRef.current = true;

    try {
      setLoading(true);
      setError(null);
      // A genuinely new search empties the list before it runs. An anchor-only
      // refresh keeps the scrubber and the last page painted until its sought
      // page replaces them.
      if (mode === 'fresh') {
        layoutFallbackRef.current = false;
        if (!preserve) setList([]);
        setCursor(null);
        setTopOffset(0);
        setAboveCursor(null);
        setSeams(new Set());
      }

      const wantsLayout = layout && mode === 'fresh' && !layoutFallbackRef.current;
      const issuedAt = performance.now();
      let resp = await execCommand<SearchResponse>(
        buildSearchCommand(parsed, limit, from, mode === 'fresh' ? anchor : null, wantsLayout, above),
        { signal },
      );
      // An exact-height index must be complete. A source beyond the server's
      // safety ceiling is paged instead, rather than taking its loaded prefix
      // for the whole timeline.
      if (wantsLayout && resp.layout && resp.truncated) {
        layoutFallbackRef.current = true;
        resp = await execCommand<SearchResponse>(buildSearchCommand(parsed, limit, undefined, anchor), { signal });
      }
      if (generation !== generationRef.current) return;
      if (mode === 'fresh') {
        // `search` answers its subjects in the order they were asked.
        const resolved = resp.filters?.subjects ?? [];
        const subjects = (parsed.subjects ?? []).flatMap((ref, i) => (resolved[i] ? [{ ref, path: resolved[i].path }] : []));
        setOutcome({ clientMs: Math.round(performance.now() - issuedAt), serverMs: resp.elapsedMs, warnings: resp.warnings ?? [], subjects });
      }

      const decoded: SearchResult[] = resp.layout ? decodeSearchLayout(resp.layout) : resp.results ?? [];
      const page = parsed.under ? decoded.map((result) => ({ ...result, stackAlbumPath: parsed.under })) : decoded;

      if (mode === 'prepend') {
        // A page asked to start `limit` earlier can reach past where the list
        // already begins — a post-filter drops rows, so the same positions do
        // not hold the same number of results. Dropping by path is both simpler
        // and correct whatever the filters did.
        const known = new Set(resultsRef.current.map((result) => result.path));
        const fresh = page.filter((result) => !known.has(result.path));
        // Captured while the DOM still shows the old list.
        hold.capture();
        const joined = resultsRef.current[0]?.path;
        if (joined) setSeams((current) => new Set(current).add(joined));
        setList([...fresh, ...resultsRef.current]);
        if (above !== undefined) {
          // Keyset: the server says whether anything is left above.
          setAboveCursor(resp.above ?? null);
          return;
        }
        // The new top is the position asked for, not the number of rows that
        // came back: everything between them was filtered out, not skipped.
        setTopOffset(from !== undefined ? parseInt(from, 10) || 0 : 0);
        return;
      }

      setList(mode === 'append' ? [...resultsRef.current, ...page] : page);
      setCursor(resp.cursor ?? null);
      if (mode === 'fresh') {
        setTopOffset(resp.offset ?? 0);
        setAboveCursor(resp.above ?? null);
        const lead = resp.anchorIndex ?? 0;
        setAnchorIndex(lead);
        setAnsweredAnchor(anchor);
        // The lead is a page above the seek, and buckets like one: the sought
        // row starts its own section, which is also what the landing scrolls to.
        setSeams(lead > 0 && page[lead] ? new Set([page[lead].path]) : new Set());
      }
    } catch (err) {
      if (generation !== generationRef.current || signal.aborted) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      if (mode === 'fresh' && !preserve) {
        setList([]);
        setCursor(null);
        setTopOffset(0);
        setAboveCursor(null);
        setSeams(new Set());
      }
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [limit, anchor, hold, setList, layout]);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    const parsed: SearchFilters = JSON.parse(filterKey);
    const queryKey = JSON.stringify({ filterKey, enabled, browseAll, debounce, reloadKey, layout, limit });
    const preserve = previousQueryRef.current === queryKey && previousAnchorRef.current !== anchor && resultsRef.current.length > 0;
    previousQueryRef.current = queryKey;
    previousAnchorRef.current = anchor;

    if (!enabled || !(browseAll || hasAnyFilter(parsed))) {
      // Invalidate anything in flight so a late response cannot repopulate.
      generationRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      setList([]);
      setCursor(null);
      setTopOffset(0);
      setAboveCursor(null);
      setSeams(new Set());
      setLoading(false);
      return;
    }

    // Query changes clear first; moving only the scrubber anchor keeps the old
    // page visible until the replacement arrives.
    if (!preserve) setList([]);
    setCursor(null);
    setTopOffset(0);
    setAboveCursor(null);
    setSeams(new Set());

    if (debounce > 0) {
      setLoading(true);
      timerRef.current = setTimeout(() => run(parsed, 'fresh', undefined, preserve), debounce) as unknown as number;
    } else {
      setLoading(true);
      run(parsed, 'fresh', undefined, preserve);
    }

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [filterKey, enabled, browseAll, debounce, run, reloadKey, setList]);

  // Leaving the page hangs up whatever search is still running for it.
  useEffect(() => () => abortRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    run(JSON.parse(filterKey), 'append', cursor);
  }, [cursor, loading, filterKey, run]);

  // No intent gate here, unlike the map and the global timeline: a seeked list
  // has its top sentinel on screen at once, and that is the point. The page
  // above loads immediately, the hold keeps the sought date where it landed,
  // and the newer pictures are simply there to scroll up into — the way they
  // would be had the reader scrolled here. It does not run away because the
  // hold moves the reader down by what arrived, which takes the sentinel out
  // of its lead until they climb again.

  // Two ways of knowing there is more above: a position to subtract from, or a
  // token the server handed out for the page above.
  const hasNewer = topOffset > 0 || aboveCursor !== null;

  const topObserverRef = useRef<IntersectionObserver | null>(null);
  const topSentinelRef = useCallback((node: HTMLElement | null) => {
    topObserverRef.current?.disconnect();
    if (!node || !hasNewer || loading) return;

    // The same 600px lead as paging downward: the picture the reader is looking
    // at is pinned through a prepend, so the page can arrive before they reach
    // the top rather than at it.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loadingRef.current) {
        if (aboveCursor !== null) run(JSON.parse(filterKey), 'prepend', undefined, false, aboveCursor);
        else run(JSON.parse(filterKey), 'prepend', String(Math.max(0, topOffset - limit)));
      }
    }, { root: scrollRoot, rootMargin: '600px' });

    observer.observe(node);
    topObserverRef.current = observer;
  }, [hasNewer, loading, topOffset, aboveCursor, limit, filterKey, run, scrollRoot]);

  useEffect(() => () => topObserverRef.current?.disconnect(), []);

  const removeResults = useCallback((paths: string[]) => {
    const drop = new Set(paths);
    setList(resultsRef.current.filter((result) => !drop.has(result.path)));
  }, [setList]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    results,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
    removeResults,
    reload,
    hasNewer,
    anchorIndex,
    answeredAnchor,
    topSentinelRef,
    seams,
    outcome,
  };
}
