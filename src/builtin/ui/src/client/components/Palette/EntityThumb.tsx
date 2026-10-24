import { Image } from '@mantine/core';
import type { EntityCompleteHit } from '../../hooks/useMentionComplete.ts';
import { useAlbumCover } from '../../hooks/useAlbums.ts';
import { useCover } from '../../hooks/useCover.ts';
import { entityKindIcon } from '../Search/entityKindIcon.tsx';

/** A finder row's picture of an entity: its cover, or its kind's icon while it has none. Fetched only once the row is drawn. */
export function EntityThumb({ hit }: { hit: EntityCompleteHit }) {
  // A completion only has a path, not the album's structure. `useAlbumCover`
  // tries both possible layouts, so an explicit cover or the first album image
  // can still become the thumbnail.
  const albumCover = useAlbumCover({ path: hit.path, hasFilesDir: true }, hit.kind === 'album');
  const entityCover = useCover(hit.path, hit.kind !== 'album');
  const coverUrl = hit.kind === 'album' ? albumCover.coverUrl : entityCover.coverUrl;
  const coverFallbackUrl = hit.kind === 'album' ? albumCover.coverFallbackUrl : entityCover.coverFallbackUrl;
  if (!coverUrl) return entityKindIcon(hit.kind, 18);
  return <Image src={coverUrl} fallbackSrc={coverFallbackUrl} alt='' w={24} h={24} fit='cover' radius='sm' />;
}
