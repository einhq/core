/**
 * What counts as a piece of media in a listing: a picture, a video or a recording as it was put
 * in — not one of the renditions or face crops made from it, which carry the `sourceId` of the
 * file they came from and sit beside or under it.
 *
 * Imports nothing, so it can be part of the module contract: core's `search --under` and media's
 * album listing have to agree on it, or an album would count differently in each.
 */
export const isOriginalMedia = (node: { type: string; attrs: Record<string, unknown> }): boolean => {
  if (node.type !== 'file') return false;
  if (node.attrs.sourceId != null) return false;
  const mimetype = typeof node.attrs.mimetype === 'string' ? node.attrs.mimetype : '';
  return mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/');
};
