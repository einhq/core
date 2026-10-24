/**
 * Arrow-key moves over tiles that wrap into rows, from their laid-out boxes.
 *
 * A wrapped list has no columns of its own: how many tiles fit a row is up to
 * the width, so the row above and the tile under the pointer are read off the
 * geometry rather than counted. Tiles are in reading order.
 */

/** A tile's place in its grid, in px; `height` where the grid gives it (hit tests need it, the arrows do not). */
export type TileBox = { left: number; top: number; width: number; height?: number };
export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export const GRID_KEYS: ReadonlySet<string> = new Set<GridKey>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Tiles whose tops differ by less than this share a row; a sub-pixel layout never lines up exactly. */
const ROW_SLACK = 2;

/**
 * The tile `key` moves to from `from`, or `null` when it leads nowhere: left of
 * the first, right of the last, above the first row, below the last. Up and
 * down land in the neighbouring row on the tile nearest in x, so a short last
 * row is still reachable from the column past its end.
 */
export function gridNeighbour(tiles: TileBox[], from: number, key: GridKey): number | null {
  if (tiles.length === 0 || from < 0 || from >= tiles.length) return null;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return tiles.length - 1;
    case 'ArrowLeft':
      return from > 0 ? from - 1 : null;
    case 'ArrowRight':
      return from < tiles.length - 1 ? from + 1 : null;
  }

  const here = tiles[from];
  const down = key === 'ArrowDown';
  const beyond = tiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => down ? tile.top > here.top + ROW_SLACK : tile.top < here.top - ROW_SLACK);
  if (beyond.length === 0) return null;

  // The nearest row in that direction, then the tile in it nearest in x.
  const rowTop = down ? Math.min(...beyond.map(({ tile }) => tile.top)) : Math.max(...beyond.map(({ tile }) => tile.top));
  const centre = here.left + here.width / 2;
  let best: { index: number; distance: number } | null = null;
  for (const { tile, index } of beyond) {
    if (Math.abs(tile.top - rowTop) > ROW_SLACK) continue;
    const distance = Math.abs(tile.left + tile.width / 2 - centre);
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best?.index ?? null;
}
