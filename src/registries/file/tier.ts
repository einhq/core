import { ResourceOptions } from '../types.ts';
import { FileTier } from './types.ts';

/**
 * Subset of a file node's attrs relevant to tier routing. Attrs reach a
 * registry as the `opts` argument, so this extends ResourceOptions; registries
 * sit below the vfs layer and do not import its FileAttrs.
 */
type TierInput = ResourceOptions & {
  tier?: FileTier;
  sourceId?: string;
  frozen?: boolean;
};

/**
 * Resolve which storage tier a file belongs to:
 * - an explicit `tier` always wins;
 * - a file generated for / attached to another node (`sourceId`) that is not
 *   `frozen` is a regenerable rendition → `volatile`;
 * - everything else (top-level originals, frozen RAW versions) → `disk`.
 */
export const tierOf = (a: TierInput | undefined): FileTier => a?.tier ?? (a?.sourceId && !a.frozen ? 'volatile' : 'disk');
