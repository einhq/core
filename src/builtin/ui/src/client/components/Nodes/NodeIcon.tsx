import { ThemeIcon } from '@mantine/core';
import {
  IconFile,
  IconFileDescription,
  IconFileDescriptionFilled,
  IconFileFilled,
  IconFileText,
  IconFileTextFilled,
  IconFolder,
  IconFolderFilled,
  IconInfoCircle,
  IconInfoCircleFilled,
  IconMapPin,
  IconMapPinFilled,
  IconPhoto,
  IconPhotoFilled,
  IconStack2,
  IconStack2Filled,
  IconUser,
  IconUserFilled,
  IconVideo,
  IconVideoFilled,
} from '@tabler/icons-react';
import { useState } from 'react';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';
import { useSettledInViewport } from '../../hooks/useSettledInViewport.ts';
import { thumbnailUrl } from '../../lib/derivatives.ts';
import { isMediaFile, type NodeChildEntry } from '../../lib/node-entry.ts';
import { nodeKindOf } from '../../lib/node-kind.ts';

const COVERED_TYPES = new Set(['album', 'person', 'location', 'device', 'track']);
/** How long a row must stay on screen before its picture is asked for; a scroll passing through asks for none. */
const SETTLE_MS = 200;
/** A picture's corners: square but for a hair, so a photo reads as a photo, not a button. */
const PICTURE_RADIUS = 1;

type NodeIconProps = {
  entry: NodeChildEntry;
  path: string;
  /** Pixel size of the glyph's box. */
  size: number;
  /** Show the picture rather than the glyph when the node has one. */
  picture?: boolean;
  /** Keep the type glyph over the picture's corner, so a picture still says what it is. */
  badge?: boolean;
};

/**
 * The solid version of a kind's glyph, where Tabler draws one: a solid shape
 * in the kind's colour reads at row size without a tinted box behind it. The
 * kinds are shared with the cards (`entity-kind.ts`), which keep the outline.
 */
const FILLED = new Map<typeof IconPhoto, typeof IconPhoto>([
  [IconFile, IconFileFilled],
  [IconFileDescription, IconFileDescriptionFilled],
  [IconFileText, IconFileTextFilled],
  [IconFolder, IconFolderFilled],
  [IconInfoCircle, IconInfoCircleFilled],
  [IconMapPin, IconMapPinFilled],
  [IconPhoto, IconPhotoFilled],
  [IconStack2, IconStack2Filled],
  [IconUser, IconUserFilled],
  [IconVideo, IconVideoFilled],
]);

/** A file that is itself a rendition has no `thumbnails/` of its own — nothing to fetch. */
const hasOwnThumbnails = (entry: NodeChildEntry): boolean => entry.node.attrs.sourceId === undefined && entry.childCount > 0;

/**
 * The node's glyph, a coloured shape with no box of its own — or, in the
 * icons view, its picture.
 *
 * A media file's thumbnail is assumed to exist rather than checked, as
 * `media-item.ts` does: the listing does not name the file's children, and a
 * lookup per row to find out would cost more than the occasional 404 the
 * fallback absorbs. Entities carry a `coverPhoto` softlink that `CoverAvatar`
 * already knows how to follow.
 *
 * A picture waits until its row has settled on screen, and the glyph stands
 * in until then: a large directory scrolled through would otherwise queue a
 * cover lookup for every row it passed, ahead of the rows it stopped at.
 */
export function NodeIcon({ entry, path, size, picture = false, badge = false }: NodeIconProps) {
  const kind = nodeKindOf(entry);
  const [broken, setBroken] = useState(false);
  const { ref, settled } = useSettledInViewport<HTMLDivElement>(SETTLE_MS);
  const Icon = kind.icon;
  const Glyph = FILLED.get(Icon) ?? Icon;
  const glyph = (
    <span
      role='img'
      aria-label={kind.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        color: `var(--mantine-color-${kind.color}-filled)`,
      }}
    >
      <Glyph size={Math.round(size * 0.9)} stroke={1.75} />
    </span>
  );

  if (!picture) return glyph;

  const thumbnail = isMediaFile(entry) && hasOwnThumbnails(entry) && !broken;
  const covered = COVERED_TYPES.has(entry.node.type);
  if (!thumbnail && !covered) return glyph;

  let shown: React.ReactNode = glyph;
  if (!settled) {
    // The glyph, in a box the viewport can watch.
  } else if (thumbnail) {
    shown = (
      <img
        src={thumbnailUrl(path, true)}
        alt={entry.name}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ width: size, height: size, objectFit: 'cover', borderRadius: PICTURE_RADIUS, display: 'block' }}
      />
    );
  } else {
    shown = <CoverAvatar path={path} size={size} radius={PICTURE_RADIUS} color={kind.color} enabled fallback={<Icon size={Math.round(size * 0.62)} stroke={1.5} />} />;
  }

  // The picture says what it shows; the glyph in the corner says what it is —
  // an album and a photo of the same moment look alike at this size otherwise.
  // Not over the glyph itself, which already says it.
  const badgeSize = Math.max(16, Math.round(size * 0.32));
  return (
    <div ref={ref} style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {shown}
      {badge && settled && (
        <ThemeIcon
          variant='filled'
          color={kind.color}
          size={badgeSize}
          radius='sm'
          aria-label={kind.label}
          style={{ position: 'absolute', right: -3, bottom: -3, boxShadow: '0 0 0 2px var(--mrx-surface-base)' }}
        >
          <Icon size={Math.round(badgeSize * 0.7)} stroke={2} />
        </ThemeIcon>
      )}
    </div>
  );
}
