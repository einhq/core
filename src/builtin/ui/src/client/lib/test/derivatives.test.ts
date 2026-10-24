/**
 * gridSrcSet: the `w` descriptors are the rendition's real width, not its bounding box.
 *
 * The renditions are `contain`, so a 3:4 portrait in an 800 box is 600px wide. Advertising
 * it as 800w — which is all the box-sized IMAGE_LADDER can do — tells the browser it has
 * more pixels than it does, and it settles for a size too small.
 */

import { assertEquals } from '@std/assert';
import {
  availableBoxes,
  displayUrl,
  GRID_FALLBACK_NAME,
  GRID_NAME,
  gridFallbackUrl,
  gridSrcSet,
  gridUrl,
  imageSrcSet,
  posterUrl,
  PREVIEW_NAME,
  previewUrl,
  THUMB_NAME,
} from '../derivatives.ts';

Deno.test('a landscape tile advertises the full box width', () => {
  assertEquals(
    gridSrcSet(`/archive/albums/a/p.jpg`, true, 3 / 2),
    `/file/archive/albums/a/p.jpg/thumbnails/512x512.avif 512w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 800w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif 1600w`,
  );
});

Deno.test('a portrait tile advertises the width it actually renders at', () => {
  assertEquals(
    gridSrcSet(`/archive/albums/a/p.jpg`, true, 3 / 4),
    `/file/archive/albums/a/p.jpg/thumbnails/512x512.avif 384w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 600w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif 1200w`,
  );
});

Deno.test('a video poster gets the same sizes as a photo', () => {
  assertEquals(
    gridSrcSet(`/archive/albums/a/v.mp4`, true, 16 / 9),
    `/file/archive/albums/a/v.mp4/thumbnails/512x512.avif 512w, ` +
      `/file/archive/albums/a/v.mp4/thumbnails/800x800.avif 800w, ` +
      `/file/archive/albums/a/v.mp4/thumbnails/1600x1600.avif 1600w`,
  );
});

Deno.test('there is no srcset without derivatives or for a broken aspect', () => {
  assertEquals(gridSrcSet('/a/p.jpg', false, 1.5), '');
  assertEquals(gridSrcSet('/a/p.jpg', true, 0), '');
  assertEquals(gridSrcSet('/a/p.jpg', true, Number.NaN), '');
});

/**
 * Audio has a rendered waveform at the same sizes as a photo, so it is offered the same
 * srcset: the tile that draws it is the same `<img>` a photo uses.
 */
Deno.test('an audio waveform gets the same sizes as a photo', () => {
  assertEquals(
    gridSrcSet(`/archive/albums/a/s.mp3`, true, 3),
    `/file/archive/albums/a/s.mp3/thumbnails/512x512.avif 512w, ` +
      `/file/archive/albums/a/s.mp3/thumbnails/800x800.avif 800w, ` +
      `/file/archive/albums/a/s.mp3/thumbnails/1600x1600.avif 1600w`,
  );
});

Deno.test('gridUrl points at the contain rendition, and at the original without derivatives', () => {
  assertEquals(gridUrl(`/archive/albums/a/p.jpg`, true), `/file/archive/albums/a/p.jpg/thumbnails/${GRID_NAME}`);
  assertEquals(gridUrl(`/archive/albums/a/p.jpg`, false), `/file/archive/albums/a/p.jpg`);
  // Audio too, since the waveform is a real picture at that size.
  assertEquals(gridUrl(`/archive/albums/a/s.mp3`, true), `/file/archive/albums/a/s.mp3/thumbnails/${GRID_NAME}`);
});

Deno.test('the tile fallback is a contain rendition, never the square crop', () => {
  const fallback = gridFallbackUrl(`/archive/albums/a/p.jpg`, true);
  assertEquals(fallback, `/file/archive/albums/a/p.jpg/thumbnails/${GRID_FALLBACK_NAME}`);
  // The whole point: a 320 cover crop here would re-crop the picture in a non-square slot.
  assertEquals(fallback.includes(THUMB_NAME), false);
  assertEquals(gridFallbackUrl(`/archive/albums/a/p.jpg`, false), `/file/archive/albums/a/p.jpg`);
});

/**
 * The hover clip is video-only and has no stand-in. Falling back to the 1080p rendition
 * would defeat the clip: megabytes of full HD streamed into a 200px slot is exactly what
 * a small preview exists to avoid, so "no preview" has to mean an empty string and a
 * tile that stays a still.
 */
Deno.test('previewUrl is video-only and never falls back', () => {
  assertEquals(previewUrl(`/archive/albums/a/v.mp4`, 'video', true), `/file/archive/albums/a/v.mp4/thumbnails/${PREVIEW_NAME}`);
  assertEquals(previewUrl(`/archive/albums/a/v.mp4`, 'video', false), '');
  assertEquals(previewUrl(`/archive/albums/a/p.jpg`, 'photo', true), '');
  assertEquals(previewUrl(`/archive/albums/a/s.mp3`, 'audio', true), '');
});

/**
 * A `<video poster>` gets a contain rendition, not the 320 square: the video itself is fitted
 * with object-fit contain, so a centre-cropped poster is the wrong picture in the wrong
 * shape for the frame it fills.
 */
Deno.test('posterUrl is a contain rendition, never the square crop', () => {
  const poster = posterUrl(`/archive/albums/a/v.mp4`, 'video', true);
  assertEquals(poster, `/file/archive/albums/a/v.mp4/thumbnails/1600x1600.avif`);
  assertEquals(poster.includes(THUMB_NAME), false);
  // Empty rather than the original: `poster=""` paints a broken-image icon over the video.
  assertEquals(posterUrl(`/archive/albums/a/v.mp4`, 'video', false), '');
  assertEquals(posterUrl(`/archive/albums/a/p.jpg`, 'photo', true), '');
});

/**
 * A source smaller than the ladder. `contain` never upscales, so `generate-derivatives`
 * stops at the first box the picture fits inside — the one that holds it at its own size —
 * and the UI must ask for nothing above it, and must describe that top size at the picture's
 * real width rather than the box's. A 600x400 photo has a 512 (512x341) and an 800 (600x400),
 * nothing more.
 */
Deno.test('availableBoxes stops at the first box the picture fits inside', () => {
  assertEquals(availableBoxes({ width: 600, height: 400 }), [512, 800]);
  assertEquals(availableBoxes({ width: 400, height: 300 }), [512]);
  assertEquals(availableBoxes({ width: 800, height: 800 }), [512, 800]);
  assertEquals(availableBoxes({ width: 801, height: 600 }), [512, 800, 1600]);
  assertEquals(availableBoxes({ width: 4000, height: 3000 }), [512, 800, 1600, 2560]);
  // A portrait fits by its long side.
  assertEquals(availableBoxes({ width: 400, height: 1000 }), [512, 800, 1600]);
  // Unknown dimensions: the whole ladder, which is what generation makes for such a file.
  assertEquals(availableBoxes(undefined), [512, 800, 1600, 2560]);
  assertEquals(availableBoxes({ width: 0, height: 0 }), [512, 800, 1600, 2560]);
});

Deno.test('a small photo advertises only the sizes it has, at its real width', () => {
  assertEquals(
    gridSrcSet(`/archive/albums/a/p.jpg`, true, 3 / 2, { width: 600, height: 400 }),
    `/file/archive/albums/a/p.jpg/thumbnails/512x512.avif 512w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 600w`,
  );
  // 1200x800 overflows the 800 box (800x533) and fits the 1600 at its own 1200.
  assertEquals(
    imageSrcSet(`/archive/albums/a/p.jpg`, 'photo', true, { width: 1200, height: 800 }),
    `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 800w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif 1200w`,
  );
  // Smaller than the whole lightbox ladder: nothing to choose between, so no srcset at
  // all and the `src` (displayUrl) carries the one size it has.
  assertEquals(imageSrcSet(`/archive/albums/a/p.jpg`, 'photo', true, { width: 400, height: 300 }), '');
  // Without dimensions the ladder is the box widths.
  assertEquals(
    imageSrcSet(`/archive/albums/a/p.jpg`, 'photo', true),
    `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 800w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif 1600w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/2560x2560.avif 2560w`,
  );
});

Deno.test('a large photo with dimensions advertises the ladder at rendered widths', () => {
  // 3000x4000 portrait: 800 box -> 600 wide, 1600 -> 1200, 2560 -> 1920.
  assertEquals(
    imageSrcSet(`/archive/albums/a/p.jpg`, 'photo', true, { width: 3000, height: 4000 }),
    `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif 600w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif 1200w, ` +
      `/file/archive/albums/a/p.jpg/thumbnails/2560x2560.avif 1920w`,
  );
});

Deno.test('the display and poster URLs step down to the largest size a small source has', () => {
  assertEquals(displayUrl(`/archive/albums/a/p.jpg`, 'photo', true, { width: 600, height: 400 }), `/file/archive/albums/a/p.jpg/thumbnails/800x800.avif`);
  assertEquals(displayUrl(`/archive/albums/a/p.jpg`, 'photo', true, { width: 400, height: 300 }), `/file/archive/albums/a/p.jpg/thumbnails/512x512.avif`);
  // Never above the fixed display size, however large the source.
  assertEquals(displayUrl(`/archive/albums/a/p.jpg`, 'photo', true, { width: 6000, height: 4000 }), `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif`);
  assertEquals(displayUrl(`/archive/albums/a/p.jpg`, 'photo', true), `/file/archive/albums/a/p.jpg/thumbnails/1600x1600.avif`);
  // Video and audio play a transcode, not a picture: dimensions change nothing.
  assertEquals(displayUrl(`/archive/albums/a/v.mp4`, 'video', true, { width: 640, height: 480 }), `/file/archive/albums/a/v.mp4/thumbnails/1920x1080.mp4`);

  assertEquals(posterUrl(`/archive/albums/a/v.mp4`, 'video', true, { width: 640, height: 480 }), `/file/archive/albums/a/v.mp4/thumbnails/800x800.avif`);
  assertEquals(posterUrl(`/archive/albums/a/v.mp4`, 'video', true, { width: 1920, height: 1080 }), `/file/archive/albums/a/v.mp4/thumbnails/1600x1600.avif`);

  // The grid's stand-in is the 800, unless the picture is too small to have one.
  assertEquals(gridFallbackUrl(`/archive/albums/a/p.jpg`, true, { width: 600, height: 400 }), `/file/archive/albums/a/p.jpg/thumbnails/${GRID_FALLBACK_NAME}`);
  assertEquals(gridFallbackUrl(`/archive/albums/a/p.jpg`, true, { width: 400, height: 300 }), `/file/archive/albums/a/p.jpg`);
});
