/**
 * The `n`th name for `base` when `base` itself is taken: `IMG_0042 (2).jpg`, `IMG_0042 (3).jpg`, …
 *
 * Numbered the way a file manager does, before the extension, so the name still opens with the
 * same program. A name whose only dot leads it (`.profile`) has no extension.
 */
export function numberedName(base: string, n: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}
