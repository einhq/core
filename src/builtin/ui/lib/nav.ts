/**
 * The web UI's navigation — the sidebar and the top bar — as configuration.
 *
 * Every module may ship a fragment, `ui/nav.json`, which `mod setup` links into
 * `/etc/ui/nav.d/<module>.json`. The administrator's `/etc/ui/nav.json` and a user's
 * `~/.ui/nav.json` are overlays in the same format, laid over the fragments in that order.
 * An entry is known by its `id` (`<module>.<name>` by convention): a layer that names an id
 * an earlier layer gave changes the fields it states and keeps the rest, one that names a
 * new id adds an entry, and `hide` takes entries away. So an overlay never copies what it
 * does not change, and a module's next version still reaches what the overlay left alone.
 *
 * Import-free on purpose: `ui-nav` uses it on the server and the browser imports its types.
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

/** A sidebar entry: a page. */
export type NavLink = {
  id: string;
  section: string;
  label: string;
  /** A Tabler icon name (`map-pin`, `heart-filled`) or a VFS path to an SVG. */
  icon: string;
  /** The app route; the entry is lit on it and below it. */
  to: string;
  order?: number;
  /** Shown to administrators only. */
  admin?: boolean;
  /** Shown to someone signed in only, never to the guest: a page of their own, or one that writes. */
  signedIn?: boolean;
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
  /** `search` stands the button beside the search box rather than with the others on the right. */
  place?: 'search';
  /**
   * A key that does what choosing the entry does, from anywhere outside a text field: Mantine's
   * hotkey form, modifiers and one key joined by `+` (`alt+R`, `mod+shift+K`; `mod` is Ctrl, or
   * Cmd on a Mac). The first entry to name a key, in top-bar order, keeps it.
   */
  shortcut?: string;
};

/**
 * A module's route drawn inside another page, at a place that page names (`slot`): a tool in the
 * node explorer's tool pane (`nodes.tools`, whose route gets the node's path for `{path}`), a tab
 * of the system page (`system.tabs`), gauges beside the host's on its overview
 * (`system.overview`), a section of the statistics page (`stats.sections`), a section of the
 * Search page before anything is asked (`search.explore`), a part above the Search page's results
 * while it asks for one label (`search.label`, whose route gets the label's tag directory for
 * `{path}`), a way to begin under the home page's
 * empty News (`home.start`), a tile on the About dialog (`about.services`). It is how a page shows a module's part without naming the module.
 */
export type PanelEntry = {
  id: string;
  slot: string;
  /** The tab's or tool's label, or the section's heading. */
  label: string;
  icon?: string;
  /** The route drawn there; `{path}` is replaced by the URI-encoded node path where the slot has one. */
  route: string;
  order?: number;
  admin?: boolean;
  signedIn?: boolean;
};

/** One file: a module's fragment or an overlay. */
export type NavLayer = {
  sections?: Partial<NavSection>[];
  sidebar?: Partial<NavLink>[];
  topbar?: Partial<TopbarEntry>[];
  panels?: Partial<PanelEntry>[];
  /** Ids to leave out, of any kind. */
  hide?: string[];
};

export type ResolvedSection = { id: string; label?: string; items: NavLink[] };
export type ResolvedTopbarEntry = TopbarEntry & { menu?: TopbarEntry[] };

/** `ui-nav`'s answer. */
export type UiNav = {
  sections: ResolvedSection[];
  topbar: ResolvedTopbarEntry[];
  /** Every slot's panels, in order; a page takes those of its own slot. */
  panels: PanelEntry[];
  /** What was left out and why: a missing field, an unknown section, an unreadable file. */
  warnings: string[];
};

/** Where a layer came from, for warnings: a module name or a file path. */
export type NamedLayer = { source: string; layer: NavLayer };

type Kind = 'sections' | 'sidebar' | 'topbar' | 'panels';
type Entry = { id: string; order?: number; admin?: boolean; signedIn?: boolean } & Record<string, unknown>;

const DEFAULT_ORDER = 1000;

const REQUIRED: Record<Kind, string[]> = {
  sections: [],
  sidebar: ['section', 'label', 'icon', 'to'],
  topbar: ['title', 'icon'],
  panels: ['slot', 'label', 'route'],
};

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
  const merged: Record<Kind, Map<string, Entry>> = { sections: new Map(), sidebar: new Map(), topbar: new Map(), panels: new Map() };
  const owner = new Map<string, string>();
  const hidden = new Set<string>();
  /** Entries this reader may not see (`admin`, `signedIn`); what names one as its parent goes with it, quietly. */
  const withheld = new Set<string>();

  const lay = ({ source, layer }: NamedLayer, overlay: boolean) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      warnings.push(`${source}: not a navigation object`);
      return;
    }
    for (const kind of ['sections', 'sidebar', 'topbar', 'panels'] as const) {
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

  /** The entries of one kind a reader gets: whole, not hidden, and theirs to see. */
  const visible = (kind: Kind): Entry[] =>
    [...merged[kind].values()].filter((entry) => {
      if (hidden.has(entry.id)) return false;
      const missing = REQUIRED[kind].filter((field) => typeof entry[field] !== 'string' || entry[field] === '');
      if (missing.length > 0) {
        warnings.push(`${entry.id}: no ${missing.join(', ')}`);
        return false;
      }
      if (kind === 'topbar' && entry.action !== undefined && !isAction(entry.action)) {
        warnings.push(`${entry.id}: action is none of navigate, dialog, drawer, fullscreen or run`);
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
  const links = byOrder(visible('sidebar') as unknown as NavLink[]).filter((link) => {
    if (known.has(link.section)) return true;
    // A hidden section takes its entries with it, which is what hiding it is for.
    if (!hidden.has(link.section)) warnings.push(`${link.id}: no section ${link.section}`);
    return false;
  });

  const entries = byOrder(visible('topbar') as unknown as TopbarEntry[]);
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
   * entry. `null`, an overlay's way to take a module's key away, goes quietly.
   */
  const claimed = new Map(SHELL_KEYS.map((key) => [hotkey(key)!, 'the shell']));
  const keyed = <T extends ResolvedTopbarEntry>(entry: T): T => {
    if (entry.shortcut === undefined) return entry;
    const { shortcut, ...rest } = entry;
    if (shortcut === null) return rest as T;
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

  return {
    sections: sections
      .map((section) => ({ id: section.id, label: section.label, items: links.filter((link) => link.section === section.id) }))
      .filter((section) => section.items.length > 0),
    topbar: topbar.map((entry) => keyed(entry.menu ? { ...entry, menu: entry.menu.map(keyed) } : entry)),
    panels: byOrder(visible('panels') as unknown as PanelEntry[]),
    warnings,
  };
};
