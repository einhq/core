import { Avatar, type MantineRadius } from '@mantine/core';
import { useInViewport } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { useCover } from '../../hooks/useCover.ts';

type CoverAvatarProps = {
  /** Path of the node that owns the cover: a person, a location, an album. */
  path: string;
  /** Drawn when the node has no cover — the kind's own icon. */
  fallback: ReactNode;
  /** Image to keep showing while the cover is absent or still loading. */
  fallbackSrc?: string;
  size?: number;
  radius?: MantineRadius | number;
  color?: string;
  alt?: string;
  /** Load on mount. Off in a grid, where the viewport decides. */
  eager?: boolean;
  /** Whether to load, decided by the caller — which then also decides when. Overrides `eager` and the viewport. */
  enabled?: boolean;
};

/**
 * A node's cover image, or its icon when it has none.
 *
 * People, locations and devices carry a `coverPhoto` softlink as albums do.
 */
export function CoverAvatar({ path, fallback, fallbackSrc, size = 80, radius, color = 'marine', alt, eager = false, enabled }: CoverAvatarProps) {
  const { ref, inViewport } = useInViewport();
  const { coverUrl } = useCover(path, enabled ?? (eager || inViewport));

  return (
    <Avatar ref={ref} size={size} radius={radius ?? size} color={color} src={coverUrl ?? fallbackSrc} alt={alt}>
      {fallback}
    </Avatar>
  );
}
