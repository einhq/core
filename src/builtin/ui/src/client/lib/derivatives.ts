/**
 * The renditions of a picture, video or recording, as the pages ask for them: by role, out of the
 * rendition table (`/etc/renditions.yaml`, `RenditionTable` in `@ein/api`) that the shell reads as
 * it loads (`renditionTable`). They live in the file's `thumbnails/` directory, each named after
 * its box (`imageFileName` and the others in `@ein/api`). A role the table lacks is no rendition:
 * the original stands in for it, or nothing where a page can do without.
 *
 * Which role a page uses is the shell's choice, made here: a grid tile draws from `grid` with
 * `small` and `medium` above it for denser displays, the lightbox lets the browser choose among
 * `small`, `medium` and `large`, and the square `thumb` serves what crops to a square anyway.
 *
 * Images are AVIF, video is AV1 in MP4, audio is AAC in MP4.
 *
 * Audio carries *both*: the `.m4a` it plays, and a rendered waveform at the same image roles a
 * photo has (EMS's `audio.waveform`). That is why nothing here special-cases it — a waveform is a
 * picture, and the tile, the srcset and the cover card all just work.
 *
 * Video carries both too, and two videos that are not a ladder: `playback` is what the lightbox
 * plays, `preview` the silent clip a grid tile hover-plays.
 *
 * A document's pictures are its first page, rendered at whatever size a box asks, so every role of
 * its kind is made whatever the page's size. What a reader shows is `documentViewUrl`.
 */

import { audioFileName, CONVERTED_DOCUMENT_MIMETYPES, DOCUMENT_VIEW_FILE, imageFileName, imageRolesOf, videoFileName } from '@ein/api';
import { renditionTable } from '../signals/renditions.ts';
import { fileUrl } from './file-url.ts';

export type MediaKind = 'photo' | 'video' | 'audio' | 'document';

/**
 * The picture as a viewer sees it — rotation and pixel aspect already applied — which is
 * what `displayDims` in `./justified-layout.ts` computes from a file node's stored raster.
 */
type PictureDims = { width: number; height: number };

/** The table every helper here answers from: none until the shell has read it. */
const table = () => renditionTable.value;

/**
 * The roles a grid tile draws from, smallest first. `grid` is the one meant; the two above it are
 * there so a 2x display at a tall row height still gets enough pixels rather than enlarging it.
 */
const GRID_ROLES = ['grid', 'small', 'medium'];

/**
 * What a tile falls back to when its `grid` rendition is missing — one the backfill has not
 * reached.
 *
 * Deliberately the next *contain* size and never the square `thumb`: the square crop has already
 * thrown away the sides of the picture, and dropping it into a non-square slot crops it a second
 * time, so a whole album would read as squares in a justified grid. Six times the bytes for the
 * tiles that need it is the better trade.
 */
const GRID_FALLBACK_ROLE = 'small';

/** The photo sizes the lightbox lets the browser choose between, smallest first. */
const LADDER_ROLES = ['small', 'medium', 'large'];

/**
 * What a photo is shown at without a srcset, and a video's poster frame: the largest of these it
 * has. A `contain` size rather than `thumb`, because the square is a centre crop, and a cropped
 * poster behind a `contain`-fitted video is the wrong picture in the wrong shape.
 */
const DISPLAY_ROLES = ['grid', 'small', 'medium'];

/**
 * The aspect a `contain` waveform is drawn at — a banner, since a waveform is a picture of
 * a timeline. Keep in step with `WAVEFORM_STYLE` in modules/archive/lib/media/image-ladder.ts.
 *
 * Unlike a photo's, this aspect is known before the image loads: the picture is synthesised
 * rather than captured, so every audio tile is this shape. The grid uses it as the
 * pre-measure aspect, which is what stops audio tiles laying out at the photo default and
 * then jumping once the waveform decodes.
 */
export const WAVEFORM_ASPECT = 3;

/**
 * The aspect a document's tile is laid out at before its page is known: a portrait A4 sheet, the
 * commonest page. A document read since has its first page's size, in points, as its `width` and
 * `height`.
 */
export const DOCUMENT_ASPECT = 1 / Math.SQRT2;

/**
 * Codecs of the video rendition, for a `<source type>`. Being explicit lets a
 * browser that cannot decode AV1 skip the source and show the poster instead of
 * a black frame.
 *
 * av01.0.08M.08 is Main profile, level 4.0, 8-bit — what SVT-AV1/NVENC emit at
 * 1080p; mp4a.40.2 is AAC-LC.
 */
export const VIDEO_SOURCE_TYPE = 'video/mp4; codecs="av01.0.08M.08,mp4a.40.2"';

/** The file an image role is (`320x320.avif`), or undefined when the table has no such role. */
export function renditionName(role: string): string | undefined {
  const rendition = table().image[role];
  return rendition ? imageFileName(rendition) : undefined;
}

const renditionUrl = (path: string, name: string): string => `${fileUrl(path)}/thumbnails/${name}`;

/**
 * Which of `roles` a picture of `kind` and `dims` has, in their order (`imageRolesOf`). A helper
 * that is given no kind asks as a photo: a tile's roles are made of every kind.
 */
const rolesHad = (roles: string[], kind: MediaKind, dims?: PictureDims): string[] => {
  const made = imageRolesOf(table(), kind, dims);
  return roles.filter((role) => made.includes(role));
};

/**
 * How wide a `contain` rendition comes out: of a picture of `dims` scaled down into the box when it
 * overflows it, its own width when it does not; with only an `aspect`, of a picture larger than the
 * box. What a `w` descriptor should say.
 */
function renderedWidth(role: string, dims: PictureDims | undefined, aspect: number): number {
  const box = table().image[role];
  if (!dims) return Math.round(Math.min(box.width, box.height * aspect));
  const scale = Math.min(1, box.width / dims.width, box.height / dims.height);
  return Math.round(dims.width * scale);
}

/**
 * Square thumbnail (`thumb`), for what crops to a square anyway: the 48px map marker and the
 * album cover card. Falls back to the original when the `thumbnails/` dir is absent (file not yet
 * indexed) or the table has no `thumb`.
 *
 * Audio has this rendition too: the waveform is drawn square for a `cover` target
 * rather than centre-cropping a banner, so the square consumers get a whole picture.
 */
export function thumbnailUrl(path: string, hasThumbnails: boolean): string {
  const name = renditionName('thumb');
  return hasThumbnails && name ? renditionUrl(path, name) : fileUrl(path);
}

/**
 * Justified-grid tile URL. Falls back to the original when the `thumbnails/` dir is
 * absent.
 *
 * A `thumbnails/` dir can lack the `grid` rendition, so this URL can still 404 — the tile handles
 * that by falling back to `gridFallbackUrl`, which is why the grid does not have to wait for a
 * backfill.
 */
export function gridUrl(path: string, hasThumbnails: boolean): string {
  const name = renditionName('grid');
  return hasThumbnails && name ? renditionUrl(path, name) : fileUrl(path);
}

/**
 * Aspect-preserving stand-in for `gridUrl` when that rendition is absent.
 *
 * With `dims`, the original instead when the picture is too small for the fallback size to have
 * been made — the tile's next step is the original anyway, so this only saves a 404.
 */
export function gridFallbackUrl(path: string, hasThumbnails: boolean, dims?: PictureDims): string {
  const name = renditionName(GRID_FALLBACK_ROLE);
  if (!hasThumbnails || !name || rolesHad([GRID_FALLBACK_ROLE], 'photo', dims).length === 0) return fileUrl(path);
  return renditionUrl(path, name);
}

/**
 * `srcset` for a grid tile.
 *
 * The aspect ratio is known here, so the `w` descriptors are the rendition's *actual*
 * width rather than its bounding box: a `contain` box B renders a portrait at `B * aspect`
 * wide. Over-promising the width makes the browser pick a size smaller than it needs on
 * portraits.
 *
 * With `dims` the roles are cut down to the sizes the picture has (`imageRolesOf`) and the
 * top one is described at the picture's own width: a 600x400 photo has only the 512 and the
 * 800, and the 800 holds 600 pixels, not 800. Over-promising *that* way makes the browser
 * pick a size that gives it fewer real pixels than it asked for. Without `dims` the aspect
 * alone still gives the right answer for anything larger than the boxes.
 *
 * Empty string when there is nothing to offer — callers must then omit the attribute
 * entirely, since an empty `srcset` makes some browsers ignore `src` as well.
 */
export function gridSrcSet(
  path: string,
  hasThumbnails: boolean,
  aspect: number,
  dims?: PictureDims,
): string {
  if (!hasThumbnails || !Number.isFinite(aspect) || aspect <= 0) {
    return '';
  }

  const seen = new Set<number>();
  const entries: string[] = [];

  for (const role of rolesHad(GRID_ROLES, 'photo', dims)) {
    const rendered = renderedWidth(role, dims, aspect);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    entries.push(`${renditionUrl(path, renditionName(role)!)} ${rendered}w`);
  }

  return entries.join(', ');
}

/**
 * Poster frame for a `<video>`, or '' when there is no rendition to point at (the caller
 * must then omit the attribute — a `poster=""` paints a broken-image icon over the video).
 *
 * With `dims`, the largest poster the video actually has: a 640x480 clip fits the 800 box,
 * so its 1600 was never made.
 */
export function posterUrl(path: string, type: MediaKind, hasThumbnails: boolean, dims?: PictureDims): string {
  if (!hasThumbnails || type !== 'video') return '';
  const role = rolesHad(DISPLAY_ROLES, 'video', dims).at(-1);
  return role ? renditionUrl(path, renditionName(role)!) : '';
}

/**
 * Hover-play clip URL (video `preview`), or '' when there is none to ask for.
 *
 * It starts where the poster frame was taken, so swapping the still for the clip shows the same
 * frame twice rather than a jump cut, and it carries no sound: a grid preview always plays muted.
 * A tile sets it as a bare `src` rather than a `<source type>`: a browser that cannot decode AV1
 * must *fail* here, so the tile hears the error, remembers there is no usable preview and leaves
 * the still in place. A typed `<source>` would be skipped silently and leave a transparent video
 * mounted over the picture.
 *
 * Never falls back to the `playback` rendition. That is the whole reason this one exists: a
 * grid asks for the clip as the pointer crosses a row, and on a phone as you scroll, so
 * megabytes of full-HD for a 200px slot is exactly what must not happen. A video without
 * a preview simply stays a still.
 *
 * `hasThumbnails` only promises the directory exists, so during a backfill this URL can
 * still 404 — the tile treats that as "no preview" and does not ask again.
 */
export function previewUrl(path: string, type: MediaKind, hasThumbnails: boolean): string {
  const preview = table().video.preview;
  return hasThumbnails && type === 'video' && preview ? renditionUrl(path, videoFileName(preview)) : '';
}

/**
 * Full/display URL: a photo's largest display size, a video's or a recording's `playback`. Falls
 * back to the original when there is no `thumbnails/` dir, or no such role.
 *
 * With `dims`, a photo gets the largest size it actually has rather than the largest the table
 * names: a 1200x800 photo fits the 1600 box, so nothing above it was made — and a 600x400 one stops
 * at the 800.
 */
export function displayUrl(path: string, type: MediaKind, hasThumbnails: boolean, dims?: PictureDims): string {
  if (!hasThumbnails) return fileUrl(path);
  if (type === 'video') return table().video.playback ? renditionUrl(path, videoFileName(table().video.playback)) : fileUrl(path);
  if (type === 'audio') return table().audio.playback ? renditionUrl(path, audioFileName(table().audio.playback)) : fileUrl(path);
  const role = type === 'document' ? rolesHad(DISPLAY_ROLES, 'document').at(-1) : rolesHad(DISPLAY_ROLES, 'photo', dims).at(-1);
  return role ? renditionUrl(path, renditionName(role)!) : fileUrl(path);
}

/**
 * What a reader shows of a document in the browser's own PDF reader: a PDF itself, or the PDF a
 * Word, OpenDocument or RTF file was converted to (`DOCUMENT_VIEW_FILE`). '' for a document with
 * neither, such as plain text, which is read as text, or one not converted yet.
 */
export function documentViewUrl(path: string, mimetype: string, hasThumbnails: boolean): string {
  if (mimetype === 'application/pdf') return fileUrl(path);
  return hasThumbnails && CONVERTED_DOCUMENT_MIMETYPES.includes(mimetype) ? renditionUrl(path, DOCUMENT_VIEW_FILE) : '';
}

/**
 * `srcset` for a photo, so the browser fetches the size its viewport and pixel
 * density actually need rather than one fixed size.
 *
 * With `dims`, only the sizes the photo has, and the top one described at the photo's own
 * width — see `gridSrcSet` for why a box-sized descriptor on a small source is a lie the
 * browser acts on. Without `dims`, the box widths: right for any photo larger than the boxes
 * and the best available guess for the rest.
 *
 * Empty string for anything without renditions or that is not a photo — callers
 * must omit the attribute entirely in that case, since an empty `srcset` makes
 * some browsers ignore `src` as well.
 */
export function imageSrcSet(path: string, type: MediaKind, hasThumbnails: boolean, dims?: PictureDims): string {
  if (!hasThumbnails || type !== 'photo') {
    return '';
  }

  const seen = new Set<number>();
  const entries: string[] = [];

  for (const role of rolesHad(LADDER_ROLES, 'photo', dims)) {
    const rendered = dims ? renderedWidth(role, dims, 1) : table().image[role].width;
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    entries.push(`${renditionUrl(path, renditionName(role)!)} ${rendered}w`);
  }

  return entries.join(', ');
}
