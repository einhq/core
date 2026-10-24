/**
 * Tabler icons by name, for `TablerIcon`: fetched through `ui-icons` and kept.
 *
 * The names asked for in one moment go as one `ui-icons` call over the shell's WebSocket,
 * not one HTTP request each: a page names twenty icons at once, and requests of their own
 * would queue behind the page's cover downloads for the browser's six connections. What
 * comes back is kept in localStorage, so a later page load draws them with no request at
 * all. The SVG files beside the app (`/icons/tabler/`) are what `ui-icons` reads.
 */
import { execCommand } from '../signals/shell-client.ts';
import { shq } from './shquote.ts';

export type ParsedIcon = { attrs: Record<string, string>; inner: string };

const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEPT_ATTRS = ['viewBox', 'fill', 'stroke', 'stroke-linecap', 'stroke-linejoin'];
const STORAGE_PREFIX = 'ein.icon.';

/** Every icon known this page load; `null` is one that does not exist. */
const loaded = new Map<string, ParsedIcon | null>();
const waiting = new Map<string, ((icon: ParsedIcon | null) => void)[]>();
let flushing: ReturnType<typeof setTimeout> | undefined;

export const isTablerName = (name: string): boolean => ICON_NAME.test(name);

const parse = (text: string): ParsedIcon | null => {
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('svg');
  if (!svg) return null;
  return {
    attrs: Object.fromEntries(KEPT_ATTRS.flatMap((a) => (svg.hasAttribute(a) ? [[a, svg.getAttribute(a)!]] : []))),
    inner: svg.innerHTML,
  };
};

/** Storage may be missing or full (a private window); an icon not kept is fetched again. */
const stored = (name: string): string | null => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + name);
  } catch {
    return null;
  }
};
const store = (name: string, text: string): void => {
  try {
    localStorage.setItem(STORAGE_PREFIX + name, text);
  } catch {
    // not kept
  }
};

/** The icon if it is known, from this page load or an earlier one; `undefined` if not yet. */
export const loadedIcon = (name: string): ParsedIcon | null | undefined => {
  if (loaded.has(name)) return loaded.get(name);
  const text = stored(name);
  if (text === null) return undefined;
  const icon = parse(text);
  loaded.set(name, icon);
  return icon;
};

const flush = async (): Promise<void> => {
  flushing = undefined;
  const names = [...waiting.keys()];
  const resolvers = new Map(waiting);
  waiting.clear();
  let answer: Record<string, string | null> = {};
  try {
    answer = await execCommand<Record<string, string | null>>(`ui-icons ${names.map(shq).join(' ')}`);
  } catch {
    // Unreachable for now; left unknown, so a later draw asks again.
  }
  for (const name of names) {
    const text = answer[name];
    const icon = typeof text === 'string' ? parse(text) : null;
    if (typeof text === 'string') store(name, text);
    if (name in answer) loaded.set(name, icon);
    for (const resolve of resolvers.get(name) ?? []) resolve(icon);
  }
};

export const loadIcon = (name: string): Promise<ParsedIcon | null> => {
  if (!isTablerName(name)) return Promise.resolve(null);
  const known = loadedIcon(name);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
    // Everything asked for while this turn renders goes in one call.
    flushing ??= setTimeout(flush, 0);
  });
};

/** Fetch these icons now, waiting at most `timeoutMs` for them. */
export const preloadIcons = async (names: Iterable<string>, timeoutMs = 1500): Promise<void> => {
  const all = Promise.all([...new Set(names)].filter(isTablerName).map(loadIcon));
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
};
