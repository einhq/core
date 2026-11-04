import { signal } from '@preact/signals-react';
import { linkVisitor } from './user.ts';
import { type NavLink, type ResolvedTopbarEntry, uiNav } from './nav.ts';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The key `mod` stands for, as this keyboard prints it: Cmd on a Mac, Ctrl elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/** Alt as this keyboard prints it. */
const ALT_KEY = IS_MAC ? '⌥' : 'Alt';

/** The caps of `mod+K` as this keyboard prints them: Cmd on a Mac, Ctrl elsewhere, a letter as on its key. */
export const keyCaps = (keys: string): string[] =>
  keys.split('+').map((key) => {
    const name = key.trim().toLowerCase();
    if (name === 'mod') return MOD_KEY;
    if (name === 'alt') return ALT_KEY;
    if (name === 'shift') return '⇧';
    if (name === 'ctrl') return 'Ctrl';
    return name.length === 1 ? name.toUpperCase() : key.trim();
  });

/** `alt+R` as a tooltip writes it: `Alt+R`, `⌥+R` on a Mac. */
export const shortcutText = (keys: string): string => keyCaps(keys).join('+');

/**
 * Whether a key is matched by where it sits rather than by what it types: a letter with Alt, which a
 * Mac types as another character (⌥R is ®).
 */
export const matchedPhysically = (keys: string): boolean => {
  const parts = keys.toLowerCase().split('+').map((part) => part.trim());
  return parts.includes('alt') && parts.some((part) => /^[a-z]$/.test(part));
};

/**
 * The top-bar entries and dropdown rows with a key (`shortcut` in a module's `ui/nav.json`), each
 * with what the shortcut overlay calls it: a row by its dropdown too (`Create › Album`). None for a
 * visitor held to their share link, who has no top bar.
 */
export const topbarShortcuts = (): KeyedEntry[] =>
  linkVisitor.value ? [] : uiNav.value.topbar
    .flatMap((entry) => [{ entry, label: entry.title }, ...(entry.menu ?? []).map((row) => ({ entry: row, label: `${entry.title} › ${row.title}` }))])
    .filter((keyed): keyed is KeyedEntry => keyed.entry.shortcut !== undefined && keyed.entry.action !== undefined);

/**
 * Whether a key types something in a text field, and so belongs to the field there. An Alt+letter
 * types nothing outside a Mac, where Option types another character; anything with Ctrl or Cmd
 * may be the field's own (`mod+C`), and Ctrl with Alt is AltGr.
 */
export const typedInFields = (keys: string): boolean => {
  const parts = keys.toLowerCase().split('+').map((part) => part.trim());
  return IS_MAC || !parts.includes('alt') || parts.some((part) => part === 'ctrl' || part === 'mod' || part === 'meta');
};

type KeyedEntry = { entry: ResolvedTopbarEntry & { shortcut: string }; label: string };

/** The sidebar's pages with a key (`shortcut` in a module's `ui/nav.json`). None for a visitor held to their share link, who has no sidebar. */
export const sidebarShortcuts = (): KeyedLink[] =>
  linkVisitor.value ? [] : uiNav.value.sections.flatMap((section) => section.items).filter((link): link is KeyedLink => link.shortcut !== undefined);

type KeyedLink = NavLink & { shortcut: string };

/** One key and what it does, as the help overlay lists it: `keys` as typed, `mod` for Ctrl or Cmd. */
export type ShortcutHelp = { keys: string; label: string };

/** The shortcuts of what is on screen now, by group, in the order the groups were mounted. */
export const shortcutGroups = signal<{ id: number; group: string; entries: readonly ShortcutHelp[] }[]>([]);

/** Whether the shortcut overlay is open; `?` opens it. */
export const shortcutHelpOpen = signal(false);

/** Open the shortcut overlay, as `?` does: for a page that names its keys rather than listing them. */
export const openShortcutHelp = (): void => {
  shortcutHelpOpen.value = true;
};

let nextId = 0;

/** List `entries` under `group` until the returned function is called. */
export function registerShortcutHelp(group: string, entries: readonly ShortcutHelp[]): () => void {
  const id = ++nextId;
  shortcutGroups.value = [...shortcutGroups.value, { id, group, entries }];
  return () => {
    shortcutGroups.value = shortcutGroups.value.filter((entry) => entry.id !== id);
  };
}
