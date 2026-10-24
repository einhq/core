/** How many columns text takes on a terminal. */

/** How many columns a code point takes: 2 for East Asian wide characters and emoji, 0 for combining marks. */
export function codePointWidth(code: number): number {
  // Combining marks, zero-width spaces and joiners, variation selectors
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

/** The columns a string without escape sequences takes. */
export const textWidth = (text: string): number => {
  let width = 0;
  for (const char of text) width += codePointWidth(char.codePointAt(0)!);
  return width;
};

/** The longest start of `text` that takes at most `width` columns. */
export const takeColumns = (text: string, width: number): string => {
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = codePointWidth(char.codePointAt(0)!);
    if (used + w > width) break;
    out += char;
    used += w;
  }
  return out;
};

/** Text cut to at most `width` columns, an ellipsis standing in for what was cut. */
export const cut = (text: string, width: number): string => {
  if (textWidth(text) <= width) return text;
  return width <= 0 ? '' : takeColumns(text, width - 1) + '…';
};
