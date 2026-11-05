/**
 * The rendition table, `/etc/renditions.yaml`: the renditions made of every picture, video and
 * recording, each under the role it plays. Pages ask for a role, and the table says which file
 * holds it: a rendition is named after its box, so nothing a page asks for names a size.
 *
 * The roles the shell asks for: `image` `thumb` (a square crop), `grid`, `small`, `medium` and
 * `large` (sizes that keep the picture's shape); `video` `preview` (a grid tile's muted clip) and
 * `playback`; `audio` `playback`; and the `storyboard`. A role the table lacks is no rendition,
 * and a page shows the original in its place. Answered by `renditions`.
 *
 * With it, the rules the pages and the pipelines that make renditions must agree on, free of
 * imports so both run the same code: which file a role is, and which roles a picture gets.
 */

/** The kinds of media a rendition is made of. */
export type RenditionKind = 'photo' | 'video' | 'audio';

/**
 * A still picture: a photo at a size, a video's poster frame, a recording's waveform.
 * `<width>x<height>.avif`.
 */
export type ImageRendition = {
  width: number;
  height: number;
  /** `cover` fills the box exactly, cropping the picture; `contain` fits inside it and never enlarges it. */
  fit: 'cover' | 'contain';
  /** The AVIF encoder's quality, 0 to 100. */
  quality: number;
  /** The kinds it is made of. */
  kinds: RenditionKind[];
};

/** A video re-encoded to fit its box, never enlarged: `<width>x<height>.mp4`. */
export type VideoRendition = {
  width: number;
  height: number;
  /** SVT-AV1's quality scale, 0 to 63: lower is better. */
  crf: number;
  preset: number;
  /** The sound's bitrate (`128k`); none with `mute`. */
  audioBitrate?: string;
  /** A clip: the second it starts at and how long it runs. */
  start?: number;
  seconds?: number;
  /** No sound at all. */
  mute?: boolean;
};

/** A recording's sound: `<bitrate>-<sampleRate>.m4a`, both ceilings against the source's own. */
export type AudioRendition = {
  bitrate: string;
  sampleRate: number;
};

/** A video's frames at an even interval tiled into one sheet: `storyboard-<tile>.avif`. */
export type StoryboardRendition = {
  /** A tile's longer side. */
  tile: number;
  columns: number;
  maxTiles: number;
  /** The shortest interval between two frames, in seconds. */
  minInterval: number;
  quality: number;
};

/** Every rendition, by role. */
export type RenditionTable = {
  image: Record<string, ImageRendition>;
  video: Record<string, VideoRendition>;
  audio: Record<string, AudioRendition>;
  storyboard?: StoryboardRendition;
};

/** No renditions at all: every page shows the original. */
export const NO_RENDITIONS: RenditionTable = { image: {}, video: {}, audio: {} };

/** A picture as a viewer sees it, rotation and pixel aspect applied. */
export type PictureSize = { width: number; height: number };

/** The file an image role is: `<width>x<height>.avif`. */
export const imageFileName = (rendition: Pick<ImageRendition, 'width' | 'height'>): string => `${rendition.width}x${rendition.height}.avif`;

/** The file a video role is: `<width>x<height>.mp4`. */
export const videoFileName = (rendition: Pick<VideoRendition, 'width' | 'height'>): string => `${rendition.width}x${rendition.height}.mp4`;

/** The file an audio role is: `<bitrate>-<sampleRate>.m4a`. */
export const audioFileName = (rendition: AudioRendition): string => `${rendition.bitrate}-${rendition.sampleRate}.m4a`;

/** The file a storyboard sheet is, named after its tile so that another tile size is another sheet. */
export const storyboardFileName = (storyboard: Pick<StoryboardRendition, 'tile'>): string => `storyboard-${storyboard.tile}.avif`;

/**
 * The image roles a picture of `kind` gets, the smallest box first. Every `cover` role of its kind:
 * it owes its consumers the exact box, and enlarges to fill it. Of the `contain` roles, every box
 * the picture overflows and the first it fits inside, which holds it at its own size; a box above
 * that would hold the very same pixels under a bigger name, so it is not made. Without the
 * picture's size, every role of its kind.
 */
export const imageRolesOf = (table: RenditionTable, kind: RenditionKind, size?: PictureSize): string[] => {
  const known = size && size.width > 0 && size.height > 0 ? size : undefined;
  const roles = Object.entries(table.image)
    .filter(([, rendition]) => rendition.kinds.includes(kind))
    .sort(([, a], [, b]) => a.width * a.height - b.width * b.height);
  const made: string[] = [];
  let fitted = false;
  for (const [role, rendition] of roles) {
    if (rendition.fit === 'cover') {
      made.push(role);
      continue;
    }
    if (fitted) continue;
    made.push(role);
    fitted = known !== undefined && rendition.width >= known.width && rendition.height >= known.height;
  }
  return made;
};
