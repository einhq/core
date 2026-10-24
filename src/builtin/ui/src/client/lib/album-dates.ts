/**
 * When an album happened.
 *
 * Two spellings: the clusterer writes an auto album's dates inside
 * `attrs.autoAlbum`, and flat `attrs.timeStart`/`attrs.timeEnd` are an album's
 * own. The flat pair wins where both exist, so a hand-set
 * range overrides a clustered one.
 *
 * Nothing is derived from the album's media here — an album with no stored dates
 * shows none rather than a range guessed from a partly-indexed listing.
 */

export type DatedAlbumAttrs = {
  timeStart?: string;
  timeEnd?: string;
  autoAlbum?: { timeStart?: string; timeEnd?: string };
};

export function albumDates(attrs: DatedAlbumAttrs | undefined): { timeStart?: string; timeEnd?: string } {
  if (!attrs) return {};
  if (attrs.timeStart) return { timeStart: attrs.timeStart, timeEnd: attrs.timeEnd };
  return { timeStart: attrs.autoAlbum?.timeStart, timeEnd: attrs.autoAlbum?.timeEnd };
}
