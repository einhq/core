/** What the shell's Markdown adds to GitHub's flavour, as rehype plugins over the sanitized tree. */

/** The text of a hast element, which is all a code block holds once sanitized. */
export type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
export const textOf = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('');

/** A heading's anchor as GitHub makes it from its text: lowercase, punctuation dropped, spaces as hyphens. */
export const headingAnchor = (text: string): string => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** Anchors for a page's headings in order: a repeated one numbered, as GitHub does. */
function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = headingAnchor(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** Gives every heading its GitHub anchor as `id`. Runs after sanitizing, which would prefix it. */
export const rehypeHeadingIds = () => (tree: HastNode) => {
  const slug = slugger();
  const walk = (node: HastNode) => {
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) node.properties = { ...node.properties, id: slug(textOf(node)) };
    else node.children?.forEach(walk);
  };
  walk(tree);
};

/** GitHub's alerts: a quote that opens with `[!NOTE]` and the like. */
export const CALLOUTS: Record<string, { title: string; color: string }> = {
  NOTE: { title: 'Note', color: 'blue' },
  TIP: { title: 'Tip', color: 'teal' },
  IMPORTANT: { title: 'Important', color: 'violet' },
  WARNING: { title: 'Warning', color: 'orange' },
  CAUTION: { title: 'Caution', color: 'red' },
};

/** A quote that is one of GitHub's alerts becomes an `aside` naming its kind, its marker taken out of the text. */
export const rehypeCallouts = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    node.children?.forEach(walk);
    if (node.type !== 'element' || node.tagName !== 'blockquote') return;
    const first = node.children?.find((child) => child.type === 'element');
    const text = first?.tagName === 'p' ? first.children?.[0] : undefined;
    const marker = text?.type === 'text' ? text.value?.match(/^\[!(\w+)\][^\S\n]*\n?/) : undefined;
    if (!first || !text || !marker || !CALLOUTS[marker[1]]) return;
    text.value = text.value!.slice(marker[0].length);
    if (!text.value) first.children!.shift();
    if (first.children![0]?.tagName === 'br') first.children!.shift();
    if (!first.children!.some((child) => child.type !== 'text' || child.value?.trim())) node.children = node.children!.filter((child) => child !== first);
    node.tagName = 'aside';
    node.properties = { dataCallout: marker[1] };
  };
  walk(tree);
};

/**
 * Keys written as GitHub writes them, `<kbd>Ctrl</kbd>`: each pair of tags around its text becomes
 * a `kbd` element. Any other HTML in the text stays dropped, as it is without this.
 */
export const rehypeKbd = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const close = child.type === 'raw' && /^<kbd>$/i.test(child.value ?? '')
        ? node.children.findIndex((next, j) => j > i && next.type === 'raw' && /^<\/kbd>$/i.test(next.value ?? ''))
        : -1;
      if (close < 0) {
        walk(child);
        children.push(child);
        continue;
      }
      children.push({ type: 'element', tagName: 'kbd', properties: {}, children: node.children.slice(i + 1, close) });
      i = close;
    }
    node.children = children;
  };
  walk(tree);
};
