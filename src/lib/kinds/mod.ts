/**
 * Content kinds — what a user thinks they are looking for.
 *
 * The vocabulary lives here with the two store conditions that do not depend on
 * any module's schema: a media kind as a mimetype prefix, and "an original, not
 * a rendition". It is core's because three layers need to name a kind: the
 * pipeline parser validating `options.entryPoint.kinds`, the metrics sampler
 * counting how many files of those kinds exist, and search.
 */

import type { AttrCondition } from '../../vfs/query.ts';
import { type Kind, MEDIA_KIND_PREFIX } from './vocabulary.ts';

export * from './vocabulary.ts';

/**
 * Push a kind set into store conditions where it is expressible.
 *
 * Only a *single* media kind becomes a mimetype prefix — the condition list is
 * AND-only, so two kinds cannot be OR-ed here and are left to classifying each
 * candidate instead. Empty when nothing can be pushed down.
 */
export const kindConditions = (kinds: Kind[]): AttrCondition[] => {
  if (kinds.length !== 1) return [];
  const prefix = MEDIA_KIND_PREFIX[kinds[0]];
  return prefix ? [{ ref: 'mimetype', op: 'prefix', value: prefix }] : [];
};

/**
 * Renditions (thumb.webp, 720p.mp4, face crops, RAW versions, …) are never
 * results in their own right. They are exactly the files attached to another
 * node via `sourceId`, so an original is one without it.
 */
export const NOT_DERIVED: AttrCondition = { ref: 'sourceId', op: 'missing' };
