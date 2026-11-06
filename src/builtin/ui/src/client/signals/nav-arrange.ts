import { signal } from '@preact/signals-react';
import type { NavLayer } from '@ui/nav';
import { type Movable, moveEntry, type NavSpot, type Placed, placedOf, READ_OWN_NAV, resetArrangement, writeOwnNavScript } from '../lib/nav-arrange.ts';
import { loadNav, uiNav } from './nav.ts';
import { execScript } from './shell-client.ts';

/** The shell's dropdown drawn as the account menu. */
export const ACCOUNT_MENU = 'ui.account';

/**
 * Whether the person is arranging their navigation: the sidebar's and the top bar's entries and the
 * account menu's rows are dragged, or chosen for a "Move to" menu, instead of opened.
 */
export const navArranging = signal(false);

/** The entry being dragged while arranging. */
export const navDragged = signal<Movable | null>(null);

/** A move or reset being written, or the last one's error. */
export const navArrangeState = signal<{ busy: boolean; error: string | null }>({ busy: false, error: null });

/** The entries drawn at a spot now, in order. */
const drawnAt = (spot: NavSpot): Placed[] => {
  const nav = uiNav.value;
  switch (spot.kind) {
    case 'section':
      return (nav.sections.find((section) => section.id === spot.section)?.items ?? []).map((link) => placedOf(link, 'sidebar'));
    case 'topbar':
      return nav.topbar.filter((entry) => entry.id !== ACCOUNT_MENU && entry.place !== 'search').map((entry) => placedOf(entry, 'topbar'));
    case 'search':
      return nav.topbar.filter((entry) => entry.place === 'search').map((entry) => placedOf(entry, 'topbar'));
    case 'menu':
      return (nav.topbar.find((entry) => entry.id === spot.parent)?.menu ?? []).map((entry) => placedOf(entry, 'topbar'));
  }
};

const readOwnNav = async (): Promise<NavLayer> => {
  const text = (await execScript(READ_OWN_NAV)).trim();
  if (!text) return {};
  const layer = JSON.parse(text);
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new Error('~/.ui/nav.json is not a navigation object');
  return layer as NavLayer;
};

// One change at a time, each on the file the one before wrote.
let writing: Promise<void> = Promise.resolve();

const change = (edit: (layer: NavLayer) => NavLayer): Promise<void> => {
  const run = async () => {
    navArrangeState.value = { busy: true, error: null };
    try {
      await execScript(writeOwnNavScript(edit(await readOwnNav())));
      await loadNav();
      navArrangeState.value = { busy: false, error: null };
    } catch (error) {
      navArrangeState.value = { busy: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  writing = writing.then(run);
  return writing;
};

/** Put an entry at a spot, before what is at `index` among the entries drawn there (the end when left out). */
export const moveNavEntry = (entry: Movable, spot: NavSpot, index?: number): Promise<void> => {
  const drawn = drawnAt(spot);
  return change((layer) => moveEntry(layer, entry, spot, drawn, index ?? drawn.length));
};

/** Move an entry one step earlier or later where it is drawn. */
export const nudgeNavEntry = (entry: Movable, spot: NavSpot, step: -1 | 1): Promise<void> => {
  const drawn = drawnAt(spot);
  const from = drawn.findIndex((other) => other.list === entry.list && other.id === entry.id);
  if (from < 0) return Promise.resolve();
  // `index` counts the entry where it stands: past the next one is two on.
  const index = step < 0 ? from - 1 : from + 2;
  if (index < 0 || index > drawn.length) return Promise.resolve();
  return change((layer) => moveEntry(layer, entry, spot, drawn, index));
};

/** Put every entry back where the modules and the administrator have it. */
export const resetNavArrangement = (): Promise<void> => change(resetArrangement);
