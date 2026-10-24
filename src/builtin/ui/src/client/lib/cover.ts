/**
 * Cover images.
 *
 * A cover is a `coverPhoto` softlink child on the owner node — an album, a
 * person, a location — pointing at a media file elsewhere. It is not an attr,
 * so reading one is a listing, and turning it into a URL takes a second listing
 * of the target: only that tells us whether derivatives exist yet.
 *
 * Both are bounded and cached here, because the callers are grids — a page of
 * person cards asks this question once per card.
 */

import { execCommand } from '../signals/shell-client.ts';
import { shq } from './shquote.ts';
import type { NodeChildEntry } from './node-entry.ts';
import { THUMB_NAME } from './derivatives.ts';
import { fileUrl } from './file-url.ts';

/** The softlink child naming a node's cover image. */
export const COVER_LINK_NAME = 'coverPhoto';

// Cards fetch only when scrolled into view, but a fast scroll can enqueue many
// at once — cap the in-flight `ls` commands so a page of cards does not fan out
// into hundreds.
const MAX_CONCURRENT = 6;
let active = 0;
const queue: Array<() => void> = [];

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const run = queue.shift()!;
    active++;
    run();
  }
}

/** Runs `task` once a slot in the shared cover queue frees up. */
export function runLimited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task().then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    });
    pump();
  });
}

/**
 * A cover picture: the rendition to draw, and the one to try when it 404s.
 *
 * The second URL exists because `thumbnails/` says only that the crawl reached
 * the file, not which renditions it produced: a file can have the directory
 * without the `grid` one.
 */
export type CoverImage = { url: string; fallbackUrl?: string };

/**
 * Cover renditions for a media path, falling back to the original.
 *
 * The `thumbnails/` dir only exists once the media crawl has reached the file,
 * so this has to be asked rather than assumed — serving the original instead is
 * a full-size JPEG behind an 80px avatar.
 *
 * `rendition` picks which rendition: the square `thumb` for a round avatar, which is
 * cropped to a square anyway, and the aspect-preserving `grid` for a card banner,
 * where the square crop would be cropped a second time.
 */
export async function mediaCoverImage(target: string, rendition: string = THUMB_NAME, fallbackRendition?: string): Promise<CoverImage | undefined> {
  let children: NodeChildEntry[];
  try {
    children = await execCommand<NodeChildEntry[]>(`ls -l ${shq(target)}`);
  } catch {
    // The target does not resolve — a `coverPhoto` left pointing at media that was
    // moved or never imported. Saying "no cover" sends the caller to its next
    // candidate; returning a URL here would render a broken <img> forever.
    return undefined;
  }

  if (!children.some((child) => child.name === 'thumbnails')) {
    // Reached but not derived yet: the original is the only thing to show.
    return { url: fileUrl(target) };
  }

  return {
    url: `${fileUrl(target)}/thumbnails/${rendition}`,
    fallbackUrl: fallbackRendition ? `${fileUrl(target)}/thumbnails/${fallbackRendition}` : undefined,
  };
}

/** A region crop, `<photo>/regions/<region>/image.avif` — what `person-cover` links a person to. */
const FACE_CROP_PATH = /^(.*)\/regions\/[^/]+\/image\.avif$/;

/**
 * The explicit cover of a node, or undefined when it has none.
 *
 * `sourcePhoto` swaps a face-crop cover for the photo it was cut from. An avatar or a card
 * wants the crop — it is the face — but a crop is at most 384 px, and stretched across a
 * page-wide banner it is a blur of skin.
 */
export async function coverLinkImage(ownerPath: string, rendition: string = THUMB_NAME, fallbackRendition?: string, sourcePhoto = false): Promise<CoverImage | undefined> {
  try {
    const children = await execCommand<NodeChildEntry[]>(`ls -l ${shq(ownerPath)}`);
    const link = children.find((child) => child.name === COVER_LINK_NAME);
    const target = link?.node.props.softlink;
    if (!target) return undefined;
    const photo = sourcePhoto ? FACE_CROP_PATH.exec(target)?.[1] : undefined;
    return await mediaCoverImage(photo ?? target, rendition, fallbackRendition);
  } catch {
    return undefined;
  }
}
