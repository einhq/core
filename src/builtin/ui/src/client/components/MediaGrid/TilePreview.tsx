import { useSignals } from '@preact/signals-react/runtime';
import type { MediaKind } from '../../lib/derivatives.ts';
import { previewUrl } from '../../lib/derivatives.ts';
import { bust } from '../../lib/derivative-version.ts';
import { activePreview, markPreviewMissing, releasePreview } from '../../lib/video-preview.ts';

type TilePreviewProps = {
  path: string;
  type: MediaKind;
  hasDerivatives: boolean;
  version: number;
};

/**
 * The hover-play clip layered over a video tile's still.
 *
 * Split out of `MediaTile` for one reason: whether a tile is the one currently playing
 * lives in a signal, and reading a signal during render subscribes the component to it.
 * A grid is thousands of tiles and only a handful are videos, so the subscription has to
 * sit in something only the video tiles mount — otherwise every photo in the album
 * re-renders each time the pointer crosses a clip.
 *
 * Mounting is the whole play/stop mechanism, and unmounting is the whole reset: the still
 * underneath is the `grid` rendition, taken at 00:00:01, and the clip starts at 00:00:01, so
 * what the reader sees before and after is the same frame.
 */
export function TilePreview({ path, type, hasDerivatives, version }: TilePreviewProps) {
  useSignals();

  if (activePreview.value !== path) return null;

  const src = bust(previewUrl(path, type, hasDerivatives), version);
  if (!src) return null;

  return (
    <video
      src={src}
      // muted + playsInline are what make autoplay legal; without them a browser silently
      // refuses and the tile just sits there looking broken.
      muted
      playsInline
      loop
      autoPlay
      preload='auto'
      // Fades up over the still once there are frames, rather than flashing a black box
      // while the first range request is in flight.
      onPlaying={(event) => {
        event.currentTarget.style.opacity = '1';
      }}
      // A video the sweep has not reached yet, or a browser that cannot decode AV1. Either
      // way: remember it, stand down, leave the still. A bare `src` rather than a typed
      // `<source>` is what makes this fire at all — a `<source type>` the browser cannot
      // play is skipped silently, leaving a transparent video mounted over the picture.
      onError={() => {
        markPreviewMissing(path);
        releasePreview(path);
      }}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        pointerEvents: 'none',
        opacity: 0,
        transition: 'opacity var(--mrx-dur-base) var(--mrx-ease)',
      }}
    />
  );
}
