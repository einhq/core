import { Box, Text } from '@mantine/core';
import { type ReactNode, useMemo } from 'react';
import { MEDIA_KINDS } from '../../lib/search-filters.ts';
import { type SearchResult, searchResultToMediaItem, type UseSearchResult } from '../../hooks/useSearch.ts';
import { useMediaSelection } from '../../hooks/useMediaSelection.ts';
import { useLoadMoreSentinel } from '../../hooks/useLoadMoreSentinel.ts';
import { MediaGrid } from '../MediaGrid/MediaGrid.tsx';
import { MediaSelectionBar, type SelectionActionContext } from '../MediaGrid/MediaSelectionBar.tsx';
import { CardGrid } from '../CardGrid/CardGrid.tsx';
import { SearchResultCard } from './SearchResultCard.tsx';

type SearchResultsProps = {
  search: UseSearchResult;
  /**
   * Overrides `search.loading` for the infinite-scroll and empty-state gates. The search page
   * passes `loading || parsing` so neither acts while a sentence is still being read.
   */
  busy?: boolean;
  /** Shown when the search came back empty. Omit to say nothing — e.g. before anything is asked. */
  emptyMessage?: string;
  /** Extra controls for the selection bar — see `MediaSelectionBar`'s `actions`. */
  selectionActions?: (ctx: SelectionActionContext) => ReactNode;
  /** Buttons for one card below the grid: what the selection bar is to the media, per album or person. */
  cardActions?: (result: SearchResult) => ReactNode;
};

/**
 * A result set from `useSearch`, in two lanes: media in the justified grid, everything else
 * as cards below it.
 *
 * Owns the selection rather than taking one, because it owns the grid the selection covers —
 * and `MediaSelectionBar` must be mounted exactly once per selection.
 */
export function SearchResults({ search, busy, emptyMessage, selectionActions, cardActions }: SearchResultsProps) {
  const { results, hasMore, loadMore, removeResults, reload } = search;
  const working = busy ?? search.loading;
  const sentinelRef = useLoadMoreSentinel(hasMore && !search.error, working, loadMore);

  const otherResults = useMemo(() => results.filter((r) => !r.kind || !MEDIA_KINDS.has(r.kind)), [results]);
  const mediaItems = useMemo(
    () => results.filter((r) => r.kind && MEDIA_KINDS.has(r.kind)).map(searchResultToMediaItem),
    [results],
  );

  const selection = useMediaSelection(mediaItems);

  return (
    <>
      {mediaItems.length > 0 && (
        <Box mb='lg'>
          <MediaGrid items={mediaItems} selection={selection} bleed />
        </Box>
      )}

      {otherResults.length > 0 && (
        <CardGrid items={otherResults} itemKey={(result) => result.path}>
          {(result) => <SearchResultCard result={result} actions={cardActions?.(result)} />}
        </CardGrid>
      )}

      {hasMore && !working && <Box ref={sentinelRef} h={1} />}

      {emptyMessage && !working && results.length === 0 && !search.error && <Text c='dimmed' ta='center' py='xl'>{emptyMessage}</Text>}

      <MediaSelectionBar
        selection={selection}
        items={mediaItems}
        onRemoved={removeResults}
        actions={selectionActions?.({ selection, items: mediaItems, reload })}
      />
    </>
  );
}
