import {
  CardGrid,
  EntityDetailHeader,
  entityKindIcon,
  hasPills,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  InterpretedFilter,
  LabelFacets,
  PageLoader,
  type PillKind,
  RoutePanel,
  SearchInput,
  SearchPills,
  SearchResultCard,
  TablerIcon,
} from '@ein/ui/components';
import { Alert, Box, Loader, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchFacetsResponse } from '@ein/api';
import { execCommand, panelRoute, panelsOf } from '@ein/ui/signals';
import { TAGS_ROOT } from '@ein/paths';
import { useSearchParams } from 'react-router-dom';
import {
  buildSearchCommand,
  ENTITY_KIND_FILTERS,
  ENTITY_KINDS,
  hasAnyFilter,
  type SearchFilters,
  useLoadMoreSentinel,
  useNodeNames,
  useSearch,
  useSearchBox,
} from '@ein/ui/hooks';
import { filtersFromParams, type MentionKind, naturalSearchDetails, paramsFromFilters, splitSubject, textFromFilters } from '@ein/ui/lib';
import { SearchLanding } from '../components/Search/SearchLanding.tsx';
import { forgetSearch, type RecentSearch, recentSearchesFrom, rememberSearch } from '../lib/recent-searches.ts';

/** What an `@` may resolve to here. An album is a result on this page, not a filter for it. */
const MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'label', 'device'];

/** Results per page, and how many skeleton cards stand in for the next one. */
const PAGE_SIZE = 60;

/** The recent searches browser storage holds; anything unreadable is no history at all. */
const readRecent = (stored: string | undefined): RecentSearch[] => {
  try {
    return recentSearchesFrom(stored === undefined ? [] : JSON.parse(stored));
  } catch {
    return [];
  }
};

/** What a search asked for, in a few words: the box's text, then its years and kinds. */
const searchLabel = (filters: SearchFilters, text: string): string => {
  const years = filters.fromYear !== undefined && filters.toYear !== undefined && filters.fromYear !== filters.toYear
    ? `${filters.fromYear}–${filters.toYear}`
    : String(filters.fromYear ?? filters.toYear ?? '');
  const kinds = filters.kinds?.length
    ? (ENTITY_KIND_FILTERS.find((entry) => entry.kinds.length === filters.kinds!.length && entry.kinds.every((kind) => filters.kinds!.includes(kind)))?.label ?? '')
    : '';
  return [text, years, kinds].filter(Boolean).join(' · ');
};

/**
 * Search: the things that hold media, rather than the media itself.
 *
 * Albums, people, locations, devices and tracks — the entities a picture hangs off.
 * The pictures are on the Media page, which is the same query pointed at files;
 * splitting them is what lets each side have controls that suit it, instead of
 * one page whose filters are half-relevant whatever you are looking for.
 *
 * The box is the Media page's (`useSearchBox`): `@` picks an entity exactly, and the words are
 * read as natural language too — "album summer 2019" is the album kind, a word and a year —
 * each thing understood becoming a chip that can be removed. Only an entity kind a sentence
 * names ("album", "people") reaches the kind control here.
 */
export default function SearchPage() {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL is the only filter state, so a search is linkable and back/forward
  // work.
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  // Nothing asked yet: the landing instead of a search for everything.
  const landing = !hasAnyFilter(filters);

  // Entity kinds only. Left unset the command would search files too, and the
  // grid here has no way to show one.
  const searchKinds = filters.kinds?.length ? filters.kinds : [...ENTITY_KINDS];
  const { results, loading, error, hasMore, loadMore, outcome } = useSearch({ ...filters, kinds: searchKinds, limit: PAGE_SIZE, enabled: !landing });

  // The labels the answer carries, from the same search counted instead of paged.
  const facetCommand = landing ? null : `${buildSearchCommand({ ...filters, kinds: searchKinds }, 1)} --facets`;
  const [facets, setFacets] = useState<{ command: string; answer: SearchFacetsResponse } | null>(null);
  useEffect(() => {
    if (!facetCommand) return;
    let current = true;
    execCommand<SearchFacetsResponse>(facetCommand).then((answer) => current && setFacets({ command: facetCommand, answer }), () => {});
    return () => {
      current = false;
    };
  }, [facetCommand]);
  const labelFacets = facets?.command === facetCommand ? facets.answer : null;

  // A search for one label gets the modules' part about it (`search.label`): archive's pictures
  // that look like it, which the label's directory names.
  const onlyLabel = filters.tags?.length === 1 ? filters.tags[0] : undefined;

  // The chips hold a subject's path, or a kind and a slug (`person:anna`), which the search
  // answers with the node it resolved to; their names are the nodes' own.
  const resolved = useMemo(() => new Map((outcome?.subjects ?? []).map(({ ref, path }) => [ref, path])), [outcome]);
  const pathOf = useCallback((kind: PillKind, value: string): string | undefined => value.startsWith('/') ? value : resolved.get(`${kind}:${value}`), [resolved]);
  const names = useNodeNames((filters.subjects ?? []).flatMap((subject) => {
    const { kind, ref } = splitSubject(subject);
    const path = kind ? pathOf(kind, ref) : ref;
    return path ? [path] : [];
  }));
  const nameOf = useCallback((kind: PillKind, value: string): string | undefined => {
    const path = pathOf(kind, value);
    return path ? names.get(path) : undefined;
  }, [names, pathOf]);

  // Kept per browser, like a search engine's history: a shared link names its search, this list
  // only what this reader ran. Remembered once the answer is in, so a name the box resolved is in
  // its label; resolving later only relabels it.
  const [recent, setRecent] = useLocalStorage<RecentSearch[]>({ key: 'ein.search.recent', defaultValue: [], deserialize: readRecent });
  const paramsKey = paramsFromFilters(filters).toString();
  const label = searchLabel(filters, textFromFilters(filters, (kind, value) => kind === 'label' ? value : nameOf(kind, value)).text);
  useEffect(() => {
    if (landing || loading || error || !label) return;
    setRecent((stored) => rememberSearch(stored, { params: paramsKey, label }));
  }, [landing, loading, error, paramsKey, label, setRecent]);

  const apply = useCallback((next: SearchFilters) => {
    setSearchParams(paramsFromFilters(next), { replace: true });
  }, [setSearchParams]);
  const box = useSearchBox({ filters, apply, natural: { kinds: ENTITY_KINDS } });
  const patch = box.patch;

  const kindFilter = useMemo(() => {
    const kinds = filters.kinds ?? [];
    return ENTITY_KIND_FILTERS.find((entry) => entry.kinds.length === kinds.length && entry.kinds.every((kind) => kinds.includes(kind))) ?? ENTITY_KIND_FILTERS[0];
  }, [filters.kinds]);

  const pagesAhead = hasMore && !error;
  const sentinelRef = useLoadMoreSentinel(pagesAhead, loading, loadMore);

  // The kind and the order have their own controls; anything else the box produced is worth
  // explaining.
  const filtered = hasAnyFilter({ ...filters, kinds: undefined });
  const details = useMemo(() => naturalSearchDetails(filters, box.interpretation, nameOf), [filters, box.interpretation, nameOf]);
  // What a picture has, which `search` answers for an album through the pictures it holds.
  const pictureFiltered = Boolean(
    filters.subjects?.length || filters.subjectNames?.length || filters.region || filters.tags?.length || filters.fromYear !== undefined ||
      filters.toYear !== undefined,
  );

  return (
    <Box>
      <EntityDetailHeader
        title='Search'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>Search for anything by name, date or @mention</Text>}
        flowContent
        controls={
          <HeaderFilterBar
            wide
            input={
              <>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <SearchInput
                    value={box.text}
                    onChange={box.setText}
                    mentions={box.mentions}
                    onMentionsChange={box.setMentions}
                    onCommit={box.commit}
                    filters={filters}
                    kinds={MENTION_KINDS}
                    size='md'
                    rightSection={box.parsing ? <Loader size={16} aria-label='Reading' /> : undefined}
                    pills={hasPills(filters) ? <SearchPills filters={filters} onPatch={patch} nameOf={nameOf} /> : undefined}
                    placeholder='Search — "album summer 2019", or type @ for a person, location, label or device'
                  />
                </Box>
                {filtered && (
                  <InterpretedFilter
                    details={details}
                    note={pictureFiltered
                      ? 'People, locations, dates and devices are what a picture has: an album matches when it holds a picture that does. A label matches an album that carries it or holds a picture that does.'
                      : undefined}
                  />
                )}
              </>
            }
          >
            <HeaderChoices>
              <HeaderChoice
                label='Show'
                variant='segmented'
                value={kindFilter.value}
                onChange={(value) => {
                  const chosen = ENTITY_KIND_FILTERS.find((entry) => entry.value === value) ?? ENTITY_KIND_FILTERS[0];
                  patch({ kinds: chosen.value === 'all' ? undefined : [...chosen.kinds] });
                }}
                options={ENTITY_KIND_FILTERS.map((entry) => ({ value: entry.value, label: entry.label, icon: entityKindIcon(entry.value) }))}
              />
              <HeaderChoice
                label='Sort'
                value={filters.sort ?? 'score'}
                onChange={(value) => patch({ sort: value === 'score' ? undefined : value as SearchFilters['sort'] })}
                options={[
                  { value: 'score', label: 'Relevance', icon: <TablerIcon name='sparkles' size={18} /> },
                  { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                  { value: '-time', label: 'Newest first', icon: <TablerIcon name='sort-descending' size={18} /> },
                  { value: 'time', label: 'Oldest first', icon: <TablerIcon name='sort-ascending' size={18} /> },
                ]}
              />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {landing && (
            <SearchLanding
              recent={recent}
              onForget={(params) => setRecent((stored) => forgetSearch(stored, params))}
              onClear={() => setRecent([])}
            />
          )}

          {box.unresolved.length > 0 && (
            <Alert color='yellow' icon={<TablerIcon name='alert-triangle' size={16} />} onClose={box.dismissUnresolved} withCloseButton>
              No person or location matched {box.unresolved.join(' or ')} — searched as plain text instead.
            </Alert>
          )}

          <Box hidden={landing}>
            {loading && results.length === 0 && <PageLoader label='Searching…' />}

            {error && <Text c='red' mb='md'>{error.message}</Text>}

            {labelFacets && (
              <Box mb='md'>
                <LabelFacets
                  labels={labelFacets.labels}
                  total={labelFacets.total}
                  chosen={filters.tags ?? []}
                  onChoose={(label) => patch({ tags: [...(filters.tags ?? []), label] })}
                />
              </Box>
            )}

            {onlyLabel && panelsOf('search.label').map((panel) => (
              <Box key={panel.id} mb='md'>
                <RoutePanel path={panelRoute(panel, `${TAGS_ROOT}/${onlyLabel}`)} />
              </Box>
            ))}

            {/* The next page is laid out as skeletons before it is asked for, and asked for as they near the viewport. */}
            <CardGrid items={results} itemKey={(result) => result.path} placeholders={pagesAhead ? PAGE_SIZE : 0} placeholderRef={sentinelRef}>
              {(result) => <SearchResultCard result={result} />}
            </CardGrid>

            {!loading && results.length === 0 && !error && <Text c='dimmed' ta='center' py='xl'>No results found</Text>}
          </Box>
        </Stack>
      </Box>
    </Box>
  );
}
