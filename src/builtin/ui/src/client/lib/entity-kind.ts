/**
 * What a card stands for, and how it says so before its title is read.
 *
 * One vocabulary rather than an icon per page and a badge colour per page: the
 * search grid mixes every kind in a single grid, so an album only reads as an
 * album at a glance if it is the same icon and the same hue everywhere it
 * appears — in the corner flag on the cover, in the glyph a coverless card
 * falls back to, and in the badge a search hit carries.
 *
 * Colours are Mantine palette names rather than raw values so the same name
 * drives a `Badge`, a `ThemeIcon` and the flag's own CSS variable. They are
 * picked to stay apart from each other on a near-black surface, and the flag
 * shade is dark enough that a white glyph on it stays legible.
 */
import { IconDeviceCameraPhone, IconFileText, IconMapPin, IconMusic, IconPhoto, IconQuestionMark, IconRoute, IconSparkles, IconUser } from '@tabler/icons-react';

export type EntityKind = 'album' | 'suggested' | 'person' | 'location' | 'device' | 'track' | 'audio' | 'document' | 'other';

export type EntityKindStyle = {
  /** Human name, used as the flag's accessible label. */
  label: string;
  /** Mantine palette name. */
  color: string;
  icon: typeof IconPhoto;
};

/** Named `…_STYLES` because `ENTITY_KINDS` already names the search filter vocabulary. */
export const ENTITY_KIND_STYLES: Record<EntityKind, EntityKindStyle> = {
  // The navbar's Albums glyph, so the flag and the menu name the same thing.
  album: { label: 'Album', color: 'blue', icon: IconPhoto },
  // What made it, not what it holds: a suggested album is an album the
  // clusterer proposed, and whether to trust its grouping is the first thing
  // to know about it.
  suggested: { label: 'Suggested album', color: 'violet', icon: IconSparkles },
  person: { label: 'Person', color: 'grape', icon: IconUser },
  location: { label: 'Location', color: 'teal', icon: IconMapPin },
  device: { label: 'Device', color: 'orange', icon: IconDeviceCameraPhone },
  track: { label: 'Track', color: 'cyan', icon: IconRoute },
  audio: { label: 'Audio', color: 'pink', icon: IconMusic },
  document: { label: 'Document', color: 'lime', icon: IconFileText },
  other: { label: 'Item', color: 'gray', icon: IconQuestionMark },
};

/** Solid fill for the corner flag, under a white glyph. */
export const kindFill = (kind: EntityKind): string => `var(--mantine-color-${ENTITY_KIND_STYLES[kind].color}-8)`;

/** The same hue, lightened — for the large thin-stroke glyph a coverless card shows. */
export const kindGlyph = (kind: EntityKind): string => `var(--mantine-color-${ENTITY_KIND_STYLES[kind].color}-4)`;

/**
 * The kind behind a search hit.
 *
 * `type` is the node type and only decides the ones `kind` does not name; an
 * audio hit is a file node, so a bare `type === 'file'` would otherwise swallow
 * it and say nothing about what is in it.
 */
export const entityKindOf = (kind?: string, type?: string): EntityKind => {
  if (kind && kind in ENTITY_KIND_STYLES && kind !== 'other') return kind as EntityKind;
  if (kind === 'file' || type === 'file') return 'document';
  return 'other';
};
