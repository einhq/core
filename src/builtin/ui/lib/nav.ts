/**
 * The Web UI's navigation — the sidebar and the top bar — as configuration, with the panels a
 * page draws and the base layers a map offers.
 *
 * Every module may ship a fragment, `ui/nav.json`, which `mod setup` links into
 * `/etc/ui/nav.d/<module>.json`, or a module kept to groups into each group's home as
 * `/groups/<group>/.ui/nav.d/<module>.json`. The administrator's `/etc/ui/nav.json`, a group's
 * `/groups/<group>/.ui/nav.json` for its members and a user's `~/.ui/nav.json` are overlays in the
 * same format, laid over the fragments in that order.
 * An entry is known by its `id` (`<module>.<name>` by convention): a layer that names an id
 * an earlier layer gave changes the fields it states and keeps the rest, one that names a
 * new id adds an entry, a field set to `null` is taken away, and `hide` takes entries away. So
 * an overlay never copies what it does not change, and a module's next version still reaches
 * what the overlay left alone.
 *
 * A sidebar entry and a top-bar entry are each drawn where `place` and `parent` say, whichever
 * list they are given in: a page moved to the top bar is a button that opens it, a top-bar entry
 * that opens a route moved to the sidebar is a link to it, and either is a row of a dropdown
 * (`ui.account`, the account menu) when it names one as its `parent`. That is how a person
 * arranges their own navigation in `~/.ui/nav.json`.
 *
 * Import-free on purpose: `ui-nav` uses it on the server and the browser imports its types, and
 * arranging the navigation its default order.
 */

/**
 * What choosing an entry does. A module gives routes, and an entry says where to show one:
 * as the page, in the shell's dialog, in its side drawer, or full screen — the same route can
 * be all four.
 */
export type NavAction =
  /** Open a route as the page. */
  | { navigate: string }
  /** Open a route in the shell's dialog, over the page (`/devices/new`). */
  | { dialog: string }
  /** Open a route in the shell's side drawer, or close it when it is the one open (`/chat`). */
  | { drawer: string }
  /** Open a route full screen, over everything; Back closes it (`/media/…`, the lightbox). */
  | { fullscreen: string }
  /**
   * Run a command line; with `navigate`, then go where its JSON answer says: `{key}` in the
   * route is replaced by the answer's `key`, URI-encoded (`album-random` answers `{ path }`,
   * opened as `/albums/{path}`).
   */
  | { run: string; navigate?: string };

/** A group of sidebar entries; a section without `label` has no heading. */
type NavSection = { id: string; label?: string; order?: number };

/**
 * Where an entry is drawn: in the sidebar under its `section`, in the top bar, or in the top bar
 * beside the search box. Left out, an entry is drawn in the list it is given in.
 */
export type NavPlace = 'sidebar' | 'topbar' | 'search';

/** The list an entry is given in, `sidebar` or `topbar`, which is where an overlay changes it. */
export type NavList = 'sidebar' | 'topbar';

/** A sidebar entry: a page. */
export type NavLink = {
  id: string;
  /** The sidebar section it is drawn under. */
  section: string;
  label: string;
  /** A Tabler icon name (`map-pin`, `heart-filled`) or a VFS path to an SVG. */
  icon: string;
  /** The app route; the entry is lit on it and below it. */
  to: string;
  /**
   * What choosing it does instead of opening `to` as the page, away from that page: open the route
   * in the drawer or the dialog. A top-bar entry moved to the sidebar keeps its action here.
   */
  action?: NavAction;
  /** Filled in by `ui-nav`, as for every entry drawn. */
  order?: number;
  /** Shown to administrators only. */
  admin?: boolean;
  /** Shown to someone signed in only, never to the guest: a page of their own, or one that writes. */
  signedIn?: boolean;
  /** A key that opens the page from anywhere outside a text field, in the top bar's form (`alt+P`). */
  shortcut?: string;
  /** In the top bar (`topbar`, `search`) it is a button that opens the page. */
  place?: NavPlace;
  /** A top-bar dropdown it is a row of, wherever `place` says. */
  parent?: string;
  /** The list it is given in, which `ui-nav` fills in: where an overlay changes it, wherever it is drawn. */
  list?: NavList;
};

/**
 * A top-bar entry: a button with `action`, or a dropdown when other entries name it as
 * `parent`. An entry with a `parent` is a row of that dropdown.
 */
type TopbarEntry = {
  id: string;
  /** The tooltip of a button, the text of a dropdown row. */
  title: string;
  icon: string;
  /** A Mantine palette name for the icon (`blue`, `grape`). */
  color?: string;
  /** A dropdown's heading. */
  label?: string;
  parent?: string;
  action?: NavAction;
  order?: number;
  admin?: boolean;
  signedIn?: boolean;
  /** `false` leaves the button out on a phone. */
  phone?: boolean;
  /**
   * `search` stands the button beside the search box rather than with the others on the right.
   * `sidebar` draws an entry whose action opens a route as a link under `section`; one that runs
   * a command, or a dropdown, stays in the top bar.
   */
  place?: NavPlace;
  /** The sidebar section it is drawn under, with `place: 'sidebar'`. */
  section?: string;
  /** The list it is given in, which `ui-nav` fills in: where an overlay changes it, wherever it is drawn. */
  list?: NavList;
  /**
   * A key that does what choosing the entry does, from anywhere outside a text field: Mantine's
   * hotkey form, modifiers and one key joined by `+` (`alt+R`, `mod+shift+K`; `mod` is Ctrl, or
   * Cmd on a Mac). The first entry to name a key keeps it: the sidebar's in order, then the top
   * bar's.
   */
  shortcut?: string;
};

/**
 * A module's route drawn inside another page, at a place that page names (`slot`): a tool in the
 * node explorer's tool pane (`nodes.tools`, whose route gets the node's path for `{path}`), a tab
 * of the system page (`system.tabs`), gauges beside the host's on its overview
 * (`system.overview`), columns after EiN's own on the Work tab's flow board (`system.flow`, drawn
 * with `FlowColumn` and the rest of `Flow.tsx` so the board reads as one row), a section of the statistics page (`stats.sections`), a section of the
 * Search page before anything is asked (`search.explore`), a part above the Search page's results
 * while it asks for one label (`search.label`, whose route gets the label's tag directory for
 * `{path}`), a way to begin under the home page's
 * empty News (`home.start`), a tile on the About dialog (`about.services`), a tab of a device's page
 * after its own (`device.tabs`, whose route gets the device's path, `/dev/<device>`, for `{path}`),
 * a button in the Devices page's header beside its filters (`devices.header`), something floating over every page and the lightbox, under a dialog (`shell.float`, which places
 * what it draws itself). It is how a page shows a module's part without naming the module.
 */
export type PanelEntry = {
  id: string;
  slot: string;
  /** The tab's or tool's label, or the section's heading. */
  label: string;
  icon?: string;
  /** The route drawn there; `{path}` is replaced by the URI-encoded node path where the slot has one. */
  route: string;
  /**
   * Which nodes it is shown for: `has` names a node type the node must have a child of
   * (`{ "has": "track" }`, a device's tab only on a device with a track endpoint). `device.tabs`
   * checks it; the other slots ignore it.
   */
  when?: { has?: string };
  order?: number;
  admin?: boolean;
  signedIn?: boolean;
};

/**
 * One base layer a map offers, in its layer picker: a stack of tile sets drawn bottom first (a base
 * and its labels; a chart over the map it does not cover). A tile set's options are Leaflet's
 * `TileLayerOptions` (`attribution`, `minZoom`, `maxNativeZoom`, `maxZoom`, …). The first layer
 * in order is what a map shows when nothing names another.
 */
export type MapLayerEntry = {
  id: string;
  label: string;
  tiles: MapTiles[];
  order?: number;
  admin?: boolean;
  signedIn?: boolean;
};

/**
 * One tile set: a URL template (`{z}`, `{x}`, `{y}`, `{s}`) and Leaflet's options for it. `detail`
 * marks one a small map leaves out, such as sea marks over the map, with its attribution.
 */
export type MapTiles = { url: string; options?: Record<string, unknown>; detail?: boolean };

/** An entry as a layer gives it: any of its fields, `null` for one an overlay takes away. */
type Layered<T> = { [K in keyof T]?: T[K] | null };

/** One file: a module's fragment or an overlay. */
export type NavLayer = {
  sections?: Layered<NavSection>[];
  sidebar?: Layered<NavLink>[];
  topbar?: Layered<TopbarEntry>[];
  panels?: Layered<PanelEntry>[];
  layers?: Layered<MapLayerEntry>[];
  /** Ids to leave out, of any kind. */
  hide?: string[];
};

/**
 * A section and the links drawn in it, from either list, each with its `list` and `order` filled
 * in. Empty when nothing is drawn there: the shell leaves it out unless the navigation is being arranged.
 */
export type ResolvedSection = { id: string; label?: string; items: NavLink[] };
/** A top-bar entry or dropdown row as drawn, from either list, with its `list` and `order` filled in. */
export type ResolvedTopbarEntry = TopbarEntry & { menu?: TopbarEntry[] };

/** `ui-nav`'s answer. */
export type UiNav = {
  sections: ResolvedSection[];
  topbar: ResolvedTopbarEntry[];
  /** Every slot's panels, in order; a page takes those of its own slot. */
  panels: PanelEntry[];
  /** The maps' base layers, in order. */
  layers: MapLayerEntry[];
  /** What was left out and why: a missing field, an unknown section, an unreadable file. */
  warnings: string[];
};

/** Where a layer came from, for warnings: a module name or a file path. */
export type NamedLayer = { source: string; layer: NavLayer };

const KINDS = ['sections', 'sidebar', 'topbar', 'panels', 'layers'] as const;
type Kind = typeof KINDS[number];
type Entry = { id: string; order?: number; admin?: boolean; signedIn?: boolean } & Record<string, unknown>;

/** The order of an entry that gives none. */
export const DEFAULT_ORDER = 1000;

const REQUIRED: Record<Kind, string[]> = {
  sections: [],
  sidebar: ['section', 'label', 'icon', 'to'],
  topbar: ['title', 'icon'],
  panels: ['slot', 'label', 'route'],
  layers: ['label'],
};

const isWhen = (value: unknown): value is PanelEntry['when'] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.entries(value).every(([key, field]) => key === 'has' && typeof field === 'string' && field !== '');

const isTiles = (value: unknown): value is MapTiles[] =>
  Array.isArray(value) && value.length > 0 &&
  value.every((tiles) =>
    tiles && typeof tiles === 'object' && typeof tiles.url === 'string' && tiles.url !== '' &&
    (tiles.options === undefined || (typeof tiles.options === 'object' && tiles.options !== null && !Array.isArray(tiles.options))) &&
    (tiles.detail === undefined || typeof tiles.detail === 'boolean')
  );

/** The route an action opens, as the page or over it; none for one that runs a command. */
const routeOf = (action: NavAction): string | undefined =>
  'navigate' in action && !('run' in action)
    ? action.navigate
    : 'dialog' in action
    ? action.dialog
    : 'drawer' in action
    ? action.drawer
    : 'fullscreen' in action
    ? action.fullscreen
    : undefined;

const isAction = (value: unknown): value is NavAction => {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return ['navigate', 'dialog', 'drawer', 'fullscreen', 'run'].some((kind) => typeof action[kind] === 'string');
};

const MODIFIERS = ['alt', 'ctrl', 'meta', 'mod', 'shift'];

/** A shortcut as one key's name, `alt+r` for `Alt+R` and `r+alt`, or undefined when it is not modifiers and one key. */
const hotkey = (shortcut: string): string | undefined => {
  const parts = shortcut.toLowerCase().split('+').map((part) => part.trim());
  const keys = parts.filter((part) => !MODIFIERS.includes(part));
  if (keys.length !== 1 || keys[0] === '' || new Set(parts).size !== parts.length) return undefined;
  return parts.sort().join('+');
};

/** The shell's own keys — the finder, the shortcut list, the terminal's — which no entry may take. */
const SHELL_KEYS = ['mod+K', 'shift+?', ...['T', 'N', 'M', 'W', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((key) => `alt+${key}`)];

/** Order by `order`, then by where the entry first appeared. */
const byOrder = <T extends { order?: number }>(entries: T[]): T[] =>
  entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.order ?? DEFAULT_ORDER) - (b.entry.order ?? DEFAULT_ORDER) || a.index - b.index)
    .map(({ entry }) => entry);

/**
 * Lay the layers over each other, first to last, and resolve the result for one reader.
 *
 * Modules' fragments come first, sorted by module name so the result does not depend on
 * the order a directory lists in; two modules giving the same id is a warning and the first
 * keeps it, since neither has the right to change the other's entry. Overlays may.
 */
export const resolveNav = (fragments: NamedLayer[], overlays: NamedLayer[], reader: { admin: boolean; guest: boolean }): UiNav => {
  const warnings: string[] = [];
  const merged = Object.fromEntries(KINDS.map((kind) => [kind, new Map<string, Entry>()])) as Record<Kind, Map<string, Entry>>;
  const owner = new Map<string, string>();
  const hidden = new Set<string>();
  /** Entries this reader may not see (`admin`, `signedIn`); what names one as its parent goes with it, quietly. */
  const withheld = new Set<string>();

  const lay = ({ source, layer }: NamedLayer, overlay: boolean) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      warnings.push(`${source}: not a navigation object`);
      return;
    }
    for (const kind of KINDS) {
      const list = layer[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        warnings.push(`${source}: ${kind} is not a list`);
        continue;
      }
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
          warnings.push(`${source}: a ${kind} entry without an id`);
          continue;
        }
        const entry = raw as Entry;
        const key = `${kind}:${entry.id}`;
        const existing = merged[kind].get(entry.id);
        if (existing && !overlay) {
          warnings.push(`${source}: ${entry.id} is already given by ${owner.get(key)}`);
          continue;
        }
        merged[kind].set(entry.id, { ...existing, ...entry });
        if (!existing) owner.set(key, source);
      }
    }
    if (layer.hide !== undefined) {
      if (Array.isArray(layer.hide)) layer.hide.filter((id) => typeof id === 'string').forEach((id) => hidden.add(id));
      else warnings.push(`${source}: hide is not a list`);
    }
  };

  [...fragments].sort((a, b) => a.source.localeCompare(b.source)).forEach((layer) => lay(layer, false));
  overlays.forEach((layer) => lay(layer, true));

  /** The entries of one kind a reader gets: whole, not hidden, and theirs to see, without the fields an overlay took away. */
  const visible = (kind: Kind): Entry[] =>
    [...merged[kind].values()].map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null)) as Entry).filter((entry) => {
      if (hidden.has(entry.id)) return false;
      const missing = REQUIRED[kind].filter((field) => typeof entry[field] !== 'string' || entry[field] === '');
      if (missing.length > 0) {
        warnings.push(`${entry.id}: no ${missing.join(', ')}`);
        return false;
      }
      if ((kind === 'topbar' || kind === 'sidebar') && entry.action !== undefined && !isAction(entry.action)) {
        warnings.push(`${entry.id}: action is none of navigate, dialog, drawer, fullscreen or run`);
        return false;
      }
      if (kind === 'layers' && !isTiles(entry.tiles)) {
        warnings.push(`${entry.id}: tiles is not a list of { url, options, detail }`);
        return false;
      }
      if (kind === 'panels' && entry.when !== undefined && !isWhen(entry.when)) {
        warnings.push(`${entry.id}: when is not { has: <node type> }`);
        return false;
      }
      if ((entry.admin === true && !reader.admin) || (entry.signedIn === true && reader.guest)) {
        withheld.add(entry.id);
        return false;
      }
      return true;
    });

  const sections = byOrder(visible('sections') as unknown as NavSection[]);
  const known = new Set(sections.map((section) => section.id));

  // Each entry where it is drawn: given in the sidebar first, so that is the order of arrival.
  const linked: NavLink[] = [];
  const barred: ResolvedTopbarEntry[] = [];
  for (const entry of visible('sidebar') as unknown as NavLink[]) {
    const { to, label, section: _section, place, ...rest } = entry;
    const order = entry.order ?? DEFAULT_ORDER;
    if (entry.parent !== undefined || place === 'topbar' || place === 'search') {
      barred.push({
        ...rest,
        list: 'sidebar',
        order,
        title: label,
        action: entry.action ?? { navigate: to },
        ...(place === 'search' && entry.parent === undefined ? { place } : {}),
      });
    } else if (known.has(entry.section)) {
      const { place: _place, ...link } = entry;
      linked.push({ ...link, list: 'sidebar', order });
    } // A hidden section takes its entries with it, which is what hiding it is for.
    else if (!hidden.has(entry.section)) warnings.push(`${entry.id}: no section ${entry.section}`);
  }
  for (const entry of visible('topbar') as unknown as TopbarEntry[]) {
    const order = entry.order ?? DEFAULT_ORDER;
    const { place, section, ...rest } = entry;
    if (entry.parent === undefined && place === 'sidebar') {
      // One that cannot go there stays in the top bar, so it is not lost.
      const route = entry.action && routeOf(entry.action);
      if (route === undefined) warnings.push(`${entry.id}: only an entry that opens a route goes in the sidebar`);
      else if (section !== undefined && known.has(section)) {
        const { title, action, color: _color, label: _label, phone: _phone, ...link } = rest;
        linked.push({ ...link, list: 'topbar', order, section, label: title, to: route, ...(action && !('navigate' in action) ? { action } : {}) });
        continue;
      } else if (section !== undefined && hidden.has(section)) continue;
      else warnings.push(`${entry.id}: no section ${section ?? 'named'}`);
    }
    barred.push({ ...rest, list: 'topbar', order, ...(place === 'search' ? { place } : {}) });
  }

  const links = byOrder(linked);
  const entries = byOrder(barred);
  const tops = entries.filter((entry) => entry.parent === undefined);
  const topIds = new Set(tops.map((entry) => entry.id));
  for (const entry of entries) {
    if (entry.parent !== undefined && !topIds.has(entry.parent) && !hidden.has(entry.parent) && !withheld.has(entry.parent)) {
      warnings.push(`${entry.id}: no top-bar entry ${entry.parent}`);
    }
  }
  const topbar = tops.flatMap((entry): ResolvedTopbarEntry[] => {
    const menu = entries.filter((child) => child.parent === entry.id && child.action !== undefined);
    if (menu.length > 0) return [{ ...entry, menu }];
    // A button that does nothing, or a dropdown whose rows were all hidden, is left out.
    return entry.action !== undefined ? [entry] : [];
  });

  /**
   * Keep an entry's shortcut if it can be bound and is free, or drop it with a warning and keep the
   * entry.
   */
  const claimed = new Map(SHELL_KEYS.map((key) => [hotkey(key)!, 'the shell']));
  const keyed = <T extends { id: string; shortcut?: string; menu?: unknown[] }>(entry: T): T => {
    if (entry.shortcut === undefined) return entry;
    const { shortcut, ...rest } = entry;
    const key = typeof shortcut === 'string' ? hotkey(shortcut) : undefined;
    if (key === undefined) warnings.push(`${entry.id}: shortcut ${JSON.stringify(shortcut)} is not modifiers and one key joined by +`);
    else if (entry.menu) warnings.push(`${entry.id}: a dropdown has no shortcut, its rows may`);
    else if (claimed.has(key)) warnings.push(`${entry.id}: shortcut ${shortcut} is already ${claimed.get(key)}'s`);
    else {
      claimed.set(key, entry.id);
      return entry;
    }
    return rest as T;
  };

  const resolvedSections = sections.map((section) => ({ id: section.id, label: section.label, items: links.filter((link) => link.section === section.id).map(keyed) }));

  return {
    sections: resolvedSections,
    topbar: topbar.map((entry) => keyed(entry.menu ? { ...entry, menu: entry.menu.map(keyed) } : entry)),
    panels: byOrder(visible('panels') as unknown as PanelEntry[]),
    layers: byOrder(visible('layers') as unknown as MapLayerEntry[]),
    warnings,
  };
};
