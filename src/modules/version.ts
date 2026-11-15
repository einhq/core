/** Module versions as ranges see them. */

import { type Range, satisfies, type SemVer } from '@std/semver';

/**
 * Whether `version` is in `range`, a prerelease counting as the release it leads to: `0.6.0-dev.3`
 * is in `^0.6.0`, so a range names releases alone and still takes the prereleases before them.
 */
export const inRange = (version: SemVer, range: Range): boolean => satisfies({ ...version, prerelease: [], build: [] }, range);
