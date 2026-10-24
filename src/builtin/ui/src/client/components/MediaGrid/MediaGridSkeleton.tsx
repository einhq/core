import { Box, Skeleton } from '@mantine/core';
import { defaultRowHeight, justifiedLayout } from '../../lib/justified-layout.ts';

/**
 * A plausible spread of shapes: mostly landscape, a few portraits, one panorama. Fixed
 * rather than random, because a re-render must not reshuffle the placeholder.
 */
const SHAPES = [
  1.5,
  1.33,
  0.75,
  1.5,
  1.78,
  1,
  0.66,
  1.5,
  1.33,
  2.2,
  1.5,
  0.75,
  1.78,
  1.33,
  1,
  1.5,
  0.66,
  1.5,
  1.33,
  1.78,
  0.75,
  1.5,
  1.33,
  1.5,
];

type Props = {
  containerWidth: number;
  targetRowHeight?: number;
  gap?: number;
  itemsPerRow?: number;
};

/**
 * Placeholder tiles in the shape of the grid that is about to appear.
 *
 * Runs the same layout function as the real grid, so the swap does not jump — and so
 * every page load exercises it.
 */
export function MediaGridSkeleton({ containerWidth, targetRowHeight, gap = 3, itemsPerRow }: Props) {
  const target = targetRowHeight ?? defaultRowHeight(containerWidth);
  const layout = justifiedLayout(SHAPES, { containerWidth, targetRowHeight: target, gap, itemsPerRow });

  // Before the container is measured there is no geometry to draw; reserve a couple of
  // rows so the page does not collapse and then push everything down.
  if (layout.tiles.length === 0) {
    return <Box style={{ height: target * 2 + gap }} />;
  }

  return (
    <Box style={{ position: 'relative', height: layout.height }}>
      {layout.tiles.map((tile) => (
        <Skeleton
          key={tile.index}
          radius={0}
          style={{ position: 'absolute', left: tile.left, top: tile.top, width: tile.width, height: tile.height }}
        />
      ))}
    </Box>
  );
}
