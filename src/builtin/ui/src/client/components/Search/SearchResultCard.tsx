import { Badge } from '@mantine/core';
import type { ReactNode } from 'react';
import { useInViewport } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import type { SearchResult } from '../../hooks/useSearch.ts';
import { useAlbumCover } from '../../hooks/useAlbums.ts';
import { useCover } from '../../hooks/useCover.ts';
import { useNodeAttrs } from '../../hooks/useNodeAttrs.ts';
import { albumDates, type DatedAlbumAttrs } from '../../lib/album-dates.ts';
import { ENTITY_KIND_STYLES, entityKindOf } from '../../lib/entity-kind.ts';
import { GRID_NAME, THUMB_NAME } from '../../lib/derivatives.ts';
import { openRoute } from '../../signals/module-ui.ts';
import { EntityCard } from '../EntityCard/EntityCard.tsx';

/** Grid shape for a set of result cards. Every kind uses the same card, so one grid holds them all. */
export const RESULT_GRID_COLS = { base: 2, sm: 3, md: 4, lg: 5 };

/**
 * Where a non-media hit goes when clicked — the page a module gives its node type (`ui.open`) —
 * or null when nothing can show it.
 */
export function searchResultRoute(result: SearchResult): string | null {
  return result.kind === 'document' ? null : openRoute(result.type, result.path);
}

type SearchResultCardProps = {
  result: SearchResult;
  /** Buttons along the card's foot. */
  actions?: ReactNode;
};

/**
 * A search hit that is not media — an album, a person, a location, a document.
 *
 * All of them render the shared `EntityCard`, so they are the same size and share
 * one grid in score order. Only where the picture comes from differs: an album
 * falls back to its first member, a person or location has a `coverPhoto` and
 * nothing else, a document has no picture at all.
 */
export function SearchResultCard({ result, actions }: SearchResultCardProps) {
  const navigate = useNavigate();
  const route = searchResultRoute(result);
  const isAlbum = result.kind === 'album';
  // The folder, not the auto-album sparkle: an album hit routes to /albums whether
  // the clusterer made it or a person did, and nothing here can tell the two apart
  // until the lazy attrs land — a flag that flips once loaded is worse than one flag.
  const kind = entityKindOf(result.kind, result.type);

  const { ref, inViewport } = useInViewport();

  // A search hit carries no listing, so `hasFilesDir` is a guess; useAlbumCover probes
  // the other shape when the guess misses.
  const album = useAlbumCover({ path: result.path, hasFilesDir: true }, inViewport && isAlbum);
  const owner = useCover(result.path, inViewport && !isAlbum, { rendition: GRID_NAME, fallbackRendition: THUMB_NAME });

  // The dates, labels and description behind an album card come from its attrs, and a
  // hit has none — `--fields description` is all the command was asked for. One extra
  // lazy `attrs`, only for album hits that are on screen.
  const { attrs } = useNodeAttrs<DatedAlbumAttrs & { description?: string; labels?: string[] }>(
    result.path,
    inViewport && isAlbum,
  );
  const dates = albumDates(attrs);

  const cover = isAlbum ? album : owner;

  return (
    <EntityCard
      ref={ref}
      title={result.name}
      // The name is not unique — two albums can share one — so the path stays reachable.
      hoverText={result.path}
      onClick={route ? () => navigate(route) : undefined}
      coverUrl={cover.coverUrl}
      coverFallbackUrl={cover.coverFallbackUrl}
      kind={kind}
      count={isAlbum ? album.itemCount : undefined}
      timeStart={dates.timeStart}
      timeEnd={dates.timeEnd}
      description={result.description ?? attrs?.description}
      labels={attrs?.labels}
      actions={actions}
      badges={
        <>
          <Badge size='xs' variant='light' color={ENTITY_KIND_STYLES[kind].color}>{result.kind ?? result.type}</Badge>
          {result.takenAt && <Badge size='xs' variant='outline' color='gray'>{result.takenAt.slice(0, 4)}</Badge>}
        </>
      }
    />
  );
}
