import { Box, Skeleton } from '@mantine/core';
import { useMemo } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import type { MediaItem } from '../../signals/album.ts';
import { DEFAULT_ASPECT, displayAspect, stripLayout } from '../../lib/justified-layout.ts';
import { getAspect, rememberAspect } from '../../lib/aspect-cache.ts';
import { versionOf } from '../../lib/derivative-version.ts';
import { useElementWidth } from '../../hooks/useElementWidth.ts';
import { GRID_GAP } from './MediaGrid.tsx';
import { MediaTile } from './MediaTile.tsx';

export type MediaStripProps = {
  /** The pictures to sample from, in order: a group's stack fronts. Null while they load, which draws the strip's skeleton. */
  items: MediaItem[] | null;
  /** How many the group holds in all, for the "+N" on the last tile. Defaults to the items' count. */
  total?: number;
  /** Each row's height, in px. */
  rowHeight: number;
  /** Defaults to two. */
  rows?: number;
  gap?: number;
  /** As `MediaGrid`'s `originals`: off, a file with no renditions yet draws a placeholder and asks for nothing. */
  originals?: boolean;
  /** A tile was clicked; `index` is into `items`. */
  onOpen?: (index: number) => void;
};

/**
 * A preview of a group: a few of its pictures, spread evenly over it, in `rows` rows of one
 * height filled to the width (`stripLayout`), the last tile saying how many more there are. It is
 * always the same height, so a list of strips can be windowed by arithmetic. Its tiles are not
 * focusable and do not select: the strip stands for the group, not for its pictures.
 */
export function MediaStrip({ items, total, rowHeight, rows = 2, gap = GRID_GAP, originals = true, onOpen }: MediaStripProps) {
  // For `versionOf`, read once here on behalf of every tile, as `MediaGrid` does.
  useSignals();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const aspects = useMemo(() => (items ?? []).map((item) => getAspect(item.path) ?? displayAspect(item) ?? DEFAULT_ASPECT), [items]);
  const layout = useMemo(() => stripLayout(aspects, { containerWidth: width, rowHeight, rows, gap }), [aspects, width, rowHeight, rows, gap]);
  const more = Math.max(0, (total ?? items?.length ?? 0) - layout.tiles.length);
  const last = layout.tiles[layout.tiles.length - 1];

  return (
    <Box ref={ref} pos='relative' style={{ height: layout.height, overflow: 'hidden' }}>
      {items === null || width === 0
        ? Array.from({ length: rows }, (_, row) => <Skeleton key={row} pos='absolute' top={row * (rowHeight + gap)} left={0} right={0} h={rowHeight} radius={0} />)
        : layout.tiles.map((tile) => {
          const item = items[tile.index];
          return (
            <MediaTile
              key={item.path}
              media={item}
              left={tile.left}
              top={tile.top}
              width={tile.width}
              height={tile.height}
              aspect={aspects[tile.index]}
              selectable={false}
              selected={false}
              selecting={false}
              version={versionOf(item.path)}
              starred={false}
              pinned={false}
              onOpen={() => onOpen?.(tile.index)}
              onToggle={() => {}}
              // Kept for the group's grid when it opens; the strip itself does not reflow.
              onMeasure={rememberAspect}
              focused={false}
              keys={false}
              originals={originals}
            />
          );
        })}
      {last && more > 0 && (
        <Box
          aria-hidden
          pos='absolute'
          style={{
            left: last.left,
            top: last.top,
            width: last.width,
            height: last.height,
            background: 'var(--mrx-scrim)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: 18,
            pointerEvents: 'none',
          }}
        >
          +{more.toLocaleString()}
        </Box>
      )}
    </Box>
  );
}
