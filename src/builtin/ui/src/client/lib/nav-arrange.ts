/**
 * Arranging the navigation: what moving an entry to another place writes into the person's own
 * overlay, `~/.ui/nav.json`, which `ui-nav` lays over everything else. Only where an entry is drawn
 * and its order are written; the overlay's other changes are kept as they are.
 */
import { DEFAULT_ORDER, type NavAction, type NavLayer, type NavLink, type NavList, type ResolvedTopbarEntry } from '@ui/nav';
import { shq } from './shquote.ts';

/** Where an entry can be put: under a sidebar section, in the top bar or beside its search box, or in a dropdown (`ui.account`). */
export type NavSpot =
  | { kind: 'section'; section: string }
  | { kind: 'topbar' }
  | { kind: 'search' }
  | { kind: 'menu'; parent: string };

/** An entry as the arranging knows it: the list it is given in, its id, and its order where it is drawn. */
export type Placed = { list: NavList; id: string; order: number };

/** An entry as `ui-nav` draws it, which fills in its list and order; the fallbacks are what it would fill in. */
type Drawn = { id: string; list?: NavList; order?: number };

/** An entry drawn in `list`'s place as the arranging knows it. */
export const placedOf = (entry: Drawn, list: NavList): Placed => ({ list: entry.list ?? list, id: entry.id, order: entry.order ?? DEFAULT_ORDER });

/** What an entry may be moved to: a link to a route anywhere, a command or a dropdown not to the sidebar, a dropdown not into another. */
export type Movable = Placed & { toSidebar: boolean; toMenu: boolean };

/** The fields `ui-nav` draws an entry by, which the arranging writes; resetting takes these away. */
const PLACING = ['place', 'parent', 'section', 'order'] as const;

const opensRoute = (action: NavAction | undefined): boolean => action !== undefined && !('run' in action);

/** A sidebar link as something to move. */
export const movableLink = (link: NavLink): Movable => ({ ...placedOf(link, 'sidebar'), toSidebar: true, toMenu: true });

/** A top-bar entry or row as something to move. */
export const movableEntry = (entry: ResolvedTopbarEntry): Movable => ({
  ...placedOf(entry, 'topbar'),
  toSidebar: entry.menu === undefined && opensRoute(entry.action),
  toMenu: entry.menu === undefined,
});

/** Whether an entry may be put at a spot. */
export const accepts = (spot: NavSpot, entry: Movable): boolean =>
  spot.kind === 'section' ? entry.toSidebar : spot.kind === 'menu' ? entry.toMenu && entry.id !== spot.parent : true;

/** The fields that draw an entry of `list` at `spot`; `null` takes away what a layer below said. */
const placing = (list: NavList, spot: NavSpot): Record<string, unknown> => {
  switch (spot.kind) {
    case 'section':
      return list === 'sidebar' ? { section: spot.section, place: null, parent: null } : { section: spot.section, place: 'sidebar', parent: null };
    case 'topbar':
      return { place: list === 'sidebar' ? 'topbar' : null, parent: null };
    case 'search':
      return { place: 'search', parent: null };
    case 'menu':
      return { parent: spot.parent };
  }
};

const sameEntry = (a: Placed, b: Placed) => a.list === b.list && a.id === b.id;

/** The overlay with `fields` set on one entry, added when the overlay does not name it yet. */
const withFields = (layer: NavLayer, list: NavList, id: string, fields: Record<string, unknown>): NavLayer => {
  const entries = (layer[list] ?? []) as Record<string, unknown>[];
  const found = entries.some((entry) => entry.id === id);
  const next = found ? entries.map((entry) => entry.id === id ? { ...entry, ...fields } : entry) : [...entries, { id, ...fields }];
  return { ...layer, [list]: next };
};

/**
 * Move `entry` to `spot`, before what is at `index` among `drawn` there (the entries drawn at the
 * spot now, in order, which may include the entry itself, counted where it stands). It takes an
 * order between its new neighbours', or numbers the spot's entries afresh by tens when there is
 * no whole number between them.
 */
export const moveEntry = (layer: NavLayer, entry: Placed, spot: NavSpot, drawn: Placed[], index: number): NavLayer => {
  const from = drawn.findIndex((other) => sameEntry(other, entry));
  const others = drawn.filter((other) => !sameEntry(other, entry));
  const at = Math.max(0, Math.min(others.length, from >= 0 && from < index ? index - 1 : index));
  const before = others[at - 1];
  const after = others[at];

  let next = withFields(layer, entry.list, entry.id, placing(entry.list, spot));
  const fresh = before === undefined && after === undefined
    ? entry.order
    : before === undefined
    ? after.order - 10
    : after === undefined
    ? before.order + 10
    : after.order - before.order >= 2
    ? Math.floor((before.order + after.order) / 2)
    : undefined;
  if (fresh !== undefined) return withFields(next, entry.list, entry.id, { order: fresh });

  const ordered = [...others.slice(0, at), entry, ...others.slice(at)];
  ordered.forEach((one, i) => {
    next = withFields(next, one.list, one.id, { order: (i + 1) * 10 });
  });
  return next;
};

/** The overlay without what arranging wrote: entries left with nothing but their id go, and so do lists left empty. */
export const resetArrangement = (layer: NavLayer): NavLayer => {
  const next: NavLayer = { ...layer };
  for (const list of ['sidebar', 'topbar'] as const) {
    const kept = ((layer[list] ?? []) as Record<string, unknown>[])
      .map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !(PLACING as readonly string[]).includes(key))))
      .filter((entry) => Object.keys(entry).some((key) => key !== 'id'));
    if (kept.length > 0) next[list] = kept;
    else delete next[list];
  }
  return next;
};

/** Whether an overlay says nothing. */
export const emptyLayer = (layer: NavLayer): boolean => Object.values(layer).every((value) => Array.isArray(value) && value.length === 0);

/** The script that prints the person's overlay, or nothing when there is none. */
export const READ_OWN_NAV = 'if [ -f ~/.ui/nav.json ]; then cat ~/.ui/nav.json; fi';

/** The script that writes the person's overlay, or removes it when it says nothing. */
export const writeOwnNavScript = (layer: NavLayer): string =>
  emptyLayer(layer) ? 'rm -f ~/.ui/nav.json' : `mkdir -p ~/.ui && printf '%s\\n' ${shq(JSON.stringify(layer, null, 2))} > ~/.ui/nav.json`;
