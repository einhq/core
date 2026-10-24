/**
 * Markdown as the plain text it reads as, for where only text fits: a card's line, a hover
 * title, the start of a description in a header. Each line loses its heading, quote and list
 * markers and its inline marks, a link or image is reduced to its text, and a legacy `<br>`
 * becomes a line break; the lines themselves are kept.
 */
export function plainMarkdown(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
        .replace(/^\s{0,3}(```|~~~).*$/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
        .replace(/(^|[^\w*])([*_])(\S(?:.*?\S)?)\2(?![\w*])/g, '$1$3')
        .replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, '$1')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
