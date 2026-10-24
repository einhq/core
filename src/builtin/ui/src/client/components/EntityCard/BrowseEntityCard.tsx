import { useInViewport } from '@mantine/hooks';
import { useCover } from '../../hooks/useCover.ts';
import { EntityCard, type EntityCardProps } from './EntityCard.tsx';

type BrowseEntityCardProps = Omit<EntityCardProps, 'coverUrl' | 'coverFallbackUrl' | 'ref'> & {
  /** Nodes with a cover image use it; tracks deliberately keep their route icon. */
  coverPath?: string;
};

/**
 * The shared card for browsable VFS entities other than albums.
 *
 * The visible card supplies the viewport observer, so a people/locations/devices
 * grid gets the same lazy cover loading as the album and search grids without
 * each page having to recreate the observer plumbing.
 */
export function BrowseEntityCard({ coverPath, ...props }: BrowseEntityCardProps) {
  const { ref, inViewport } = useInViewport();
  const cover = useCover(coverPath ?? '', inViewport && Boolean(coverPath));

  return <EntityCard ref={ref} {...props} coverUrl={cover.coverUrl} coverFallbackUrl={cover.coverFallbackUrl} />;
}
