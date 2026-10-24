/**
 * Aspect ratios measured from the images the grid actually loaded.
 *
 * A file without stored dimensions is laid out at an assumed ratio, and the grid corrects
 * itself once the picture decodes. Caching the correction for the
 * session means going back into an album re-uses it instead of reflowing a second time.
 *
 * Module-level rather than a signal: nothing renders off it directly, and a grid reads it
 * once when it mounts.
 */

const measured = new Map<string, number>();

export function getAspect(path: string): number | undefined {
  return measured.get(path);
}

export function rememberAspect(path: string, aspect: number): void {
  if (Number.isFinite(aspect) && aspect > 0) {
    measured.set(path, aspect);
  }
}

/** Drop a cached ratio: after a rotation the display frame's axes have swapped. */
export function forgetAspect(path: string): void {
  measured.delete(path);
}
