import { Box, Checkbox } from '@mantine/core';
import { useLongPress } from '@mantine/hooks';
import { IconHeartFilled, IconLock, IconMusic, IconPhoto, IconPlayerPlay, IconStack2 } from '@tabler/icons-react';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../../signals/album.ts';
import { gridFallbackUrl, gridSrcSet, gridUrl } from '../../lib/derivatives.ts';
import { displayDims } from '../../lib/justified-layout.ts';
import { fileUrl } from '../../lib/file-url.ts';
import { formatClock } from '../../lib/format.ts';
import { bust, bustSrcSet } from '../../lib/derivative-version.ts';
import { hasPreview, observeForPreview, pointerCanHover, releasePreview, requestPreview } from '../../lib/video-preview.ts';
import { endMediaDrag, type MediaDragPayload, startMediaDrag } from '../../lib/media-drag.ts';
import { TilePreview } from './TilePreview.tsx';

/**
 * How long the pointer must rest on a video tile before its clip is fetched.
 *
 * Without it, crossing a row of forty videos on the way to something else starts forty
 * downloads. Short enough that deliberately stopping on a tile still feels immediate.
 */
const HOVER_INTENT_MS = 200;

/**
 * How long a finger must rest on a tile before it starts a selection.
 *
 * Touch only. On a phone there is no hover to reveal the checkbox, so this is the only
 * way into picking mode; on a mouse the checkbox is already one hover away, and a 400ms
 * hold is just a slow click, which must still open the picture.
 */
const LONG_PRESS_MS = 400;

type MediaTileProps = {
  media: MediaItem;
  /** Laid-out geometry, in px. The tile never decides its own size. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Aspect the layout used, so the `srcset` can advertise real widths. */
  aspect: number;
  selectable: boolean;
  selected: boolean;
  /** The reader is picking tiles right now, so nothing should start moving. */
  selecting: boolean;
  /**
   * Cache-busting token for this file's derivatives, resolved by the grid.
   *
   * A prop rather than a `versionOf` call here: reading that signal in the tile would
   * subscribe every one of a few thousand tiles to it, and the grid can read it once.
   */
  version: number;
  /** In the reader's favourites; a prop for the same reason as `version`. */
  starred: boolean;
  /** Marked as keeping its own sharing; the grid decides whether the reader is shown that. */
  pinned: boolean;
  onOpen: () => void;
  onToggle: (mods: { range: boolean; additive: boolean }) => void;
  /** Reports the decoded dimensions so the grid can correct an assumed aspect. */
  onMeasure: (path: string, aspect: number) => void;
  /** A badge drawn in the lower-left marks row, after the heart and the lock. */
  overlay?: ReactNode;
  /** The keyboard's cursor is on this tile: drawn with a ring of its own. */
  focused: boolean;
  /** The tile takes focus, and Enter or Space opens it. Off, the page's own keys have them. */
  keys: boolean;
  /**
   * The original may be shown when no rendition can be. Off, a file without renditions draws the
   * placeholder and asks for nothing, and the fallback chain stops before the original.
   */
  originals: boolean;
  /** What dragging the tile carries; without it the tile is not dragged. */
  dragPayload?: MediaDragPayload;
};

/**
 * One picture in the justified grid, at the size the layout gave it.
 *
 * A plain `<img>` rather than Mantine's `Image`: its `fallbackSrc` swaps the element out
 * on error, which loses the `srcset` and the measured dimensions along with it. The
 * fallback is handled here instead, in steps, so a file whose `grid` rendition has
 * not been generated yet still shows a picture. With `originals` off the chain stops
 * before the original, and a file with no renditions yet draws the placeholder at once
 * without asking for anything: a grid of just-arrived files, whose originals are large
 * and often undrawable, costs no requests.
 *
 * A video tile also plays: resting the pointer on it swaps in a short silent clip, and on
 * a touch screen — where there is no pointer to rest — scrolling it into view does the
 * same. Only one tile plays at a time, page-wide; `lib/video-preview.ts` decides which.
 */
export function MediaTile({
  media,
  left,
  top,
  width,
  height,
  aspect,
  selectable,
  selected,
  selecting,
  version,
  starred,
  pinned,
  onOpen,
  onToggle,
  onMeasure,
  overlay,
  focused,
  keys,
  originals,
  dragPayload,
}: MediaTileProps) {
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState(0);
  // The chain ran out and its last step failed too: the original when `originals`
  // is on (a browser cannot draw a HEIC or a raw video frame), the `contain`
  // fallback when it is off. The common cause is a file the derivative pipeline
  // has not reached. A tile that stays blank forever reads as a broken picture
  // rather than as one that has not been made yet.
  const [exhausted, setExhausted] = useState(false);
  // The last step of the fallback chain: the original, unless it is not to be fetched.
  const lastStep = originals ? 3 : 2;
  const isVideo = media.type === 'video';
  // Audio's picture is a rendered waveform, so everything below — the `<img>`, the
  // fallback chain, `onMeasure` — treats it exactly like a photo. Only the badge and the
  // not-yet-generated placeholder need to know, and both only to pick an icon.
  const isAudio = media.type === 'audio';
  const isTimed = isVideo || isAudio;
  const duration = formatClock(media.duration);
  // A waveform that has not been rendered yet should read as audio-not-made-yet, not as a
  // broken photo.
  const PlaceholderIcon = isAudio ? IconMusic : IconPhoto;
  const hasOverlay = overlay !== undefined && overlay !== null && overlay !== false;

  // Fallback chain, every step of it aspect-preserving: the grid rendition, then the next
  // `contain` size up for files the backfill has not reached, then the original (unless
  // `originals` is off, when it stops before). The square 320 thumbnail is never in this
  // chain — it is a centre crop, so using it here would crop the picture a second time
  // inside a non-square slot and turn a whole album back into squares.
  //
  // Step 1 is the same URL as step 0 with the `srcset` dropped, and it is there because a
  // browser with a srcset never falls back to `src`: it picks a candidate and, if that one
  // 404s, the image has failed. So a size the ladder advertises but the file does not
  // have yet would take the whole tile down even though the size it needs is present.
  // Dropping the ladder asks for the one rendition we are sure of.
  //
  // `dims` is the picture's own size when the node has one: a small picture has fewer
  // sizes than the ladder, and the top one it has holds fewer pixels than its box says.
  const dims = displayDims(media);
  const src = step === 0 || step === 1
    ? gridUrl(media.path, media.hasDerivatives)
    : step === 2
    ? gridFallbackUrl(media.path, media.hasDerivatives, dims)
    : fileUrl(media.path);
  const srcSet = step === 0 ? gridSrcSet(media.path, media.hasDerivatives, aspect, dims) : '';
  // Nothing to ask for: this step is the original (no renditions yet, or none small enough), and
  // the original is not to be fetched.
  const placeholderOnly = !originals && src === fileUrl(media.path);

  // A video the backfill has already reached, when nothing else is competing for the
  // reader's attention. `hasPreview` is false once a clip has 404'd, so a grid does not
  // re-ask for a rendition that does not exist every time the pointer crosses the tile.
  //
  // Whether it is playing *right now* is `TilePreview`'s business, not this component's:
  // that answer lives in a signal, and reading it here would subscribe every tile in the
  // grid to a value only the video ones can act on.
  const canPreview = isVideo && media.hasDerivatives && !selecting && hasPreview(media.path);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef(0);

  // Touch: no hover to react to, so visibility decides. Registering only when this tile
  // could actually play keeps the shared observer down to the video tiles.
  useEffect(() => {
    if (!canPreview || pointerCanHover() || !boxRef.current) return;
    return observeForPreview(boxRef.current, media.path);
  }, [canPreview, media.path]);

  // Losing the tile mid-hover (a relayout, a filter change) must not leave it playing.
  useEffect(() => () => {
    clearTimeout(hoverTimer.current);
    releasePreview(media.path);
  }, [media.path]);

  const handleEnter = () => {
    if (!canPreview || !pointerCanHover()) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => requestPreview(media.path), HOVER_INTENT_MS);
  };

  const handleLeave = () => {
    clearTimeout(hoverTimer.current);
    releasePreview(media.path);
  };

  /** A long press has just fired, so the click the browser synthesises after it is spent. */
  const pressedRef = useRef(false);
  /** A finger is down on this tile right now. */
  const touchingRef = useRef(false);

  const longPress = useLongPress(
    () => {
      if (!selectable) return;
      pressedRef.current = true;
      onToggle({ range: false, additive: true });
      // The mode change has no hover state to announce it, so the phone says it instead.
      navigator.vibrate?.(10);
    },
    {
      events: ['touch'],
      threshold: LONG_PRESS_MS,
      // 10px. Without it, every scroll that starts on a picture selects it.
      cancelOnMove: true,
      onStart: () => {
        touchingRef.current = true;
      },
      onFinish: () => {
        touchingRef.current = false;
      },
      onCancel: () => {
        touchingRef.current = false;
      },
    },
  );

  const handleClick = (event: MouseEvent) => {
    // The click the browser synthesises when the finger comes up. Swallow it: the press
    // already toggled this tile, and by now the selection is active, so letting it
    // through would toggle the tile straight back off and the long press would appear to
    // have done nothing at all.
    if (pressedRef.current) {
      pressedRef.current = false;
      return;
    }

    if (selectable && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onToggle({ range: event.shiftKey, additive: event.metaKey || event.ctrlKey });
      return;
    }
    onOpen();
  };

  return (
    <Box
      ref={boxRef}
      className='mrx-tile'
      data-selected={selected || undefined}
      // Picking mode, read by the stylesheet: every tile shows its checkbox once
      // anything is selected, because from then on a plain click toggles rather than
      // opens. Same rule on both pointer kinds.
      data-selecting={selecting || undefined}
      // What a list that prepends finds a picture by, to put the reader back on
      // it once the rows above have changed. The preview observer reads it too, to name
      // the tile it is reporting a visibility ratio for.
      data-media-path={media.path}
      data-focused={focused || undefined}
      role='button'
      tabIndex={keys ? 0 : -1}
      draggable={dragPayload !== undefined || undefined}
      onDragStart={dragPayload
        ? (event) => {
          handleLeave();
          startMediaDrag(event, dragPayload, boxRef.current);
        }
        : undefined}
      onDragEnd={dragPayload ? endMediaDrag : undefined}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      // The filename on hover, and what the lock means. A grid is thousands of tiles, so
      // this is the native tooltip rather than a rendered one — no extra element per tile,
      // and it costs nothing until the pointer stops.
      title={pinned ? `${media.name}\nKeeps its own sharing` : media.name}
      aria-label={media.name}
      aria-pressed={selectable ? selected : undefined}
      onClick={handleClick}
      {
        // Spread only when there is a selection to add to, so the map popup's
        // non-selectable grid attaches no touch handlers at all.
        ...(selectable ? longPress : {})
      }
      // Android raises its image sheet on a long press, which `-webkit-touch-callout`
      // does not cover. Suppressed only while a finger is actually down, so a
      // right-click on the desktop still gets the browser's own menu.
      onContextMenu={(event) => {
        if (touchingRef.current) event.preventDefault();
      }}
      onKeyDown={keys
        ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }
        : undefined}
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
        cursor: 'pointer',
        overflow: 'hidden',
        // Square corners: at a tight gutter, rounded tiles read as a scatter of chips
        // rather than as rows of pictures.
        background: 'var(--mrx-media-bg)',
        // The container's height is exact, so skipping offscreen tiles cannot make the
        // page jump — it just keeps a few thousand decoded images out of memory.
        contentVisibility: 'auto',
        containIntrinsicSize: `${width}px ${height}px`,
      }}
    >
      {!placeholderOnly && (
        <img
          // Keyed on the step so a fallback that only removes the `srcset` is unambiguous:
          // the `src` attribute is unchanged between steps 0 and 1, and a browser that has
          // already failed this element may not re-run selection for an attribute edit
          // alone. `loaded` is component state, so remounting does not replay the fade.
          key={`${media.path}#${step}`}
          src={bust(src, version)}
          {...(srcSet ? { srcSet: bustSrcSet(srcSet, version), sizes: `${width}px` } : {})}
          alt={media.name}
          loading='lazy'
          decoding='async'
          draggable={false}
          onLoad={(event) => {
            setLoaded(true);
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              onMeasure(media.path, img.naturalWidth / img.naturalHeight);
            }
          }}
          onError={() =>
            setStep((s) => {
              if (s >= lastStep) setExhausted(true);
              return Math.min(s + 1, lastStep);
            })}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // Fades in as each tile decodes, so a grid fills rather than snapping. The slot
            // is already reserved by the layout, so nothing shifts.
            opacity: loaded ? 1 : 0,
            transition: 'opacity var(--mrx-dur-base) var(--mrx-ease)',
          }}
        />
      )}

      {canPreview && <TilePreview path={media.path} type={media.type} hasDerivatives={media.hasDerivatives} version={version} />}

      {(exhausted || placeholderOnly) && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--mrx-dimmed, rgba(255,255,255,.35))',
            pointerEvents: 'none',
          }}
        >
          <PlaceholderIcon size={Math.max(18, Math.min(48, Math.round(Math.min(width, height) * 0.3)))} stroke={1.25} />
        </Box>
      )}

      {isTimed && (
        <Box
          style={{
            position: 'absolute',
            bottom: 6,
            right: 6,
            background: 'var(--mrx-scrim)',
            borderRadius: 4,
            padding: '2px 6px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            pointerEvents: 'none',
          }}
        >
          {isAudio ? <IconMusic size={14} color='white' /> : <IconPlayerPlay size={14} color='white' fill='white' />}
          {duration && <span style={{ color: 'white', fontSize: 12, fontWeight: 500 }}>{duration}</span>}
        </Box>
      )}

      {(media.stackCount ?? 0) > 1 && (
        <Box
          data-media-stack-count={media.stackCount}
          aria-label={`${media.stackCount} stacked photos`}
          title={`${media.stackCount} stacked photos`}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'var(--mrx-scrim)',
            borderRadius: 4,
            padding: '2px 6px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          <IconStack2 size={15} />
          <span>{media.stackCount}</span>
        </Box>
      )}

      {selectable && (
        <Box
          className='mrx-tile-check'
          style={{ position: 'absolute', top: 6, left: 6 }}
          onClick={(event) => {
            event.stopPropagation();
            onToggle({ range: event.shiftKey, additive: true });
          }}
        >
          <Checkbox
            checked={selected}
            readOnly
            size='sm'
            radius='xl'
            aria-label={`Select ${media.name}`}
            styles={{ input: { cursor: 'pointer', borderColor: 'white' } }}
          />
        </Box>
      )}

      {(starred || pinned || hasOverlay) && (
        <Box className='mrx-tile-marks'>
          {starred && (
            <Box className='mrx-tile-star' aria-label='Favourite' title='Favourite'>
              <IconHeartFilled size={16} />
            </Box>
          )}
          {pinned && (
            <Box className='mrx-tile-lock' data-media-pinned aria-label='Keeps its own sharing' title='Keeps its own sharing'>
              <IconLock size={16} />
            </Box>
          )}
          {overlay}
        </Box>
      )}
    </Box>
  );
}
