import { assertEquals } from '@std/assert';
import { type NamedLayer, resolveNav } from '@ui/nav';

const sections = [{ id: 'main', order: 10 }, { id: 'browse', label: 'Browse', order: 20 }];

const ui: NamedLayer = {
  source: 'ui',
  layer: {
    sections,
    sidebar: [
      { id: 'ui.home', section: 'main', label: 'Home', icon: 'home', to: '/', order: 10 },
      { id: 'ui.albums', section: 'browse', label: 'Albums', icon: 'photo', to: '/albums', order: 10 },
      { id: 'ui.system', section: 'browse', label: 'System', icon: 'dashboard', to: '/system', order: 90, admin: true },
    ],
    topbar: [
      { id: 'ui.create', title: 'Create', icon: 'plus', order: 20 },
      { id: 'ui.create.album', parent: 'ui.create', title: 'Album', icon: 'photo', order: 10, action: { dialog: '/albums/new' } },
      { id: 'ui.chat', title: 'Chat', icon: 'message-circle', action: { drawer: '/chat' }, order: 10 },
    ],
  },
};

const device: NamedLayer = {
  source: 'device',
  layer: {
    sidebar: [{ id: 'archive.devices', section: 'browse', label: 'Devices', icon: 'device-camera-phone', to: '/devices', order: 20 }],
    topbar: [{ id: 'archive.create-device', parent: 'ui.create', title: 'Device', icon: 'device-camera-phone', order: 20, action: { navigate: '/devices?new' } }],
  },
};

const user = { admin: false, guest: false };
const admin = { admin: true, guest: false };
const guest = { admin: false, guest: true };
const ids = (nav: ReturnType<typeof resolveNav>) => nav.sections.map((s) => [s.id, s.items.map((i) => i.id)]);

Deno.test('ui-nav: modules contribute entries, ordered by order then arrival', () => {
  const nav = resolveNav([ui, device], [], admin);
  assertEquals(ids(nav), [['main', ['ui.home']], ['browse', ['ui.albums', 'archive.devices', 'ui.system']]]);
  assertEquals(nav.topbar.map((e) => e.id), ['ui.chat', 'ui.create']);
  assertEquals(nav.topbar[1].menu?.map((e) => e.id), ['ui.create.album', 'archive.create-device']);
  assertEquals(nav.warnings, []);
});

Deno.test('ui-nav: fragment order does not depend on the listing', () => {
  assertEquals(resolveNav([device, ui], [], admin), resolveNav([ui, device], [], admin));
});

Deno.test('ui-nav: administrator-only entries', () => {
  assertEquals(ids(resolveNav([ui], [], user)), [['main', ['ui.home']], ['browse', ['ui.albums']]]);
});

Deno.test("ui-nav: the guest gets no signed-in entries, and a withheld dropdown's rows go quietly with it", () => {
  const own: NamedLayer = {
    source: 'own',
    layer: {
      sidebar: [{ id: 'own.favourites', section: 'main', label: 'Favourites', icon: 'heart', to: '/favourites', order: 20, signedIn: true }],
      panels: [{ id: 'own.tasks', slot: 'stats.sections', label: 'Tasks', route: '/tasks', signedIn: true }],
    },
  };
  const signedInCreate: NamedLayer = { source: '/etc/ui/nav.json', layer: { topbar: [{ id: 'ui.create', signedIn: true }] } };

  const nav = resolveNav([ui, device, own], [signedInCreate], guest);
  assertEquals(ids(nav), [['main', ['ui.home']], ['browse', ['ui.albums', 'archive.devices']]]);
  assertEquals(nav.topbar.map((e) => e.id), ['ui.chat']);
  assertEquals(nav.panels, []);
  assertEquals(nav.warnings, []);

  const signedIn = resolveNav([ui, device, own], [signedInCreate], user);
  assertEquals(ids(signedIn), [['main', ['ui.home', 'own.favourites']], ['browse', ['ui.albums', 'archive.devices']]]);
  assertEquals(signedIn.topbar.map((e) => e.id), ['ui.chat', 'ui.create']);
  assertEquals(signedIn.panels.map((panel) => panel.id), ['own.tasks']);
});

Deno.test('ui-nav: an overlay changes fields, adds entries and hides them; the user comes last', () => {
  const site: NamedLayer = {
    source: '/etc/ui/nav.json',
    layer: {
      sidebar: [{ id: 'ui.albums', label: 'Photo albums' }, { id: 'site.wiki', section: 'main', label: 'Wiki', icon: 'book', to: '/docs', order: 20 }],
      hide: ['archive.devices'],
    },
  };
  const mine: NamedLayer = { source: '/home/anna/.ui/nav.json', layer: { sidebar: [{ id: 'ui.albums', label: 'Album', order: 50 }] } };
  const nav = resolveNav([ui, device], [site, mine], user);
  assertEquals(ids(nav), [['main', ['ui.home', 'site.wiki']], ['browse', ['ui.albums']]]);
  const albums = nav.sections[1].items[0];
  assertEquals([albums.label, albums.icon, albums.to], ['Album', 'photo', '/albums']);
});

Deno.test("ui-nav: one module may not take another one's id", () => {
  const thief: NamedLayer = { source: 'zzz', layer: { sidebar: [{ id: 'ui.home', label: 'Mine' }] } };
  const nav = resolveNav([ui, thief], [], user);
  assertEquals(nav.sections[0].items[0].label, 'Home');
  assertEquals(nav.warnings, ['zzz: ui.home is already given by ui']);
});

Deno.test('ui-nav: incomplete and misplaced entries are left out with a warning', () => {
  const broken: NamedLayer = {
    source: 'broken',
    layer: {
      sidebar: [{ id: 'b.nolabel', section: 'main', icon: 'x', to: '/x' }, { id: 'b.nosection', section: 'nowhere', label: 'X', icon: 'x', to: '/x' }],
      topbar: [{ id: 'b.orphan', parent: 'b.none', title: 'X', icon: 'x', action: { navigate: '/' } }, { id: 'b.bad', title: 'X', icon: 'x', action: {} as never }],
    },
  };
  const nav = resolveNav([ui, broken], [], user);
  assertEquals(nav.warnings.sort(), [
    'b.bad: action is none of navigate, dialog, drawer, fullscreen or run',
    'b.nolabel: no label',
    'b.nosection: no section nowhere',
    'b.orphan: no top-bar entry b.none',
  ]);
});

Deno.test('ui-nav: hiding every row of a dropdown hides the dropdown; empty sections go', () => {
  const nav = resolveNav([ui], [{ source: 'o', layer: { hide: ['ui.create.album', 'ui.albums'] } }], user);
  assertEquals(nav.topbar.map((e) => e.id), ['ui.chat']);
  assertEquals(ids(nav), [['main', ['ui.home']]]);
  assertEquals(nav.warnings, []);
});

Deno.test('ui-nav: an entry opens a route as the page, in the dialog, in the drawer or full screen', () => {
  const layer: NamedLayer = {
    source: 'm',
    layer: {
      topbar: [
        { id: 'm.chat', title: 'Chat', icon: 'message-circle', action: { drawer: '/chat' } },
        { id: 'ui.create', title: 'Create', icon: 'plus' },
        { id: 'm.create', parent: 'ui.create', title: 'Thing', icon: 'plus', action: { dialog: '/things/new' } },
        { id: 'm.show', title: 'Slides', icon: 'presentation', action: { fullscreen: '/slides' } },
      ],
    },
  };
  const nav = resolveNav([layer], [], user);
  assertEquals(nav.warnings, []);
  assertEquals(nav.topbar.map((entry) => [entry.id, entry.action ?? entry.menu?.map((row) => row.action)]), [
    ['m.chat', { drawer: '/chat' }],
    ['ui.create', [{ dialog: '/things/new' }]],
    ['m.show', { fullscreen: '/slides' }],
  ]);
});

Deno.test("ui-nav: a key belongs to the first entry to name it; a malformed one, the shell's own, or one on a dropdown is dropped with a warning", () => {
  const layer: NamedLayer = {
    source: 'm',
    layer: {
      topbar: [
        { id: 'ui.create', title: 'Create', icon: 'plus', shortcut: 'alt+D' },
        { id: 'm.create', parent: 'ui.create', title: 'Thing', icon: 'plus', action: { dialog: '/things/new' }, shortcut: 'alt+C' },
        { id: 'm.random', title: 'Random', icon: 'arrows-shuffle', action: { run: 'thing-random' }, shortcut: 'alt+R', order: 10 },
        { id: 'm.again', title: 'Again', icon: 'x', action: { navigate: '/' }, shortcut: 'R+Alt', order: 20 },
        { id: 'm.odd', title: 'Odd', icon: 'x', action: { navigate: '/' }, shortcut: 'alt+shift' },
        { id: 'm.terminal', title: 'Terminal', icon: 'x', action: { navigate: '/' }, shortcut: 'alt+t' },
      ],
    },
  };
  const keys = (nav: ReturnType<typeof resolveNav>) => nav.topbar.flatMap((entry) => [entry, ...(entry.menu ?? [])]).map((entry) => [entry.id, entry.shortcut]);

  const nav = resolveNav([layer], [], user);
  assertEquals(keys(nav), [['m.random', 'alt+R'], ['m.again', undefined], ['ui.create', undefined], ['m.create', 'alt+C'], ['m.odd', undefined], ['m.terminal', undefined]]);
  assertEquals(nav.warnings, [
    "m.again: shortcut R+Alt is already m.random's",
    'ui.create: a dropdown has no shortcut, its rows may',
    'm.odd: shortcut "alt+shift" is not modifiers and one key joined by +',
    "m.terminal: shortcut alt+t is already the shell's",
  ]);

  // An overlay's null takes a key away, and the next entry to name it gets it.
  const freed = resolveNav([layer], [{ source: 'o', layer: { topbar: [{ id: 'm.random', shortcut: null as never }] } }], user);
  assertEquals(keys(freed).slice(0, 2), [['m.random', undefined], ['m.again', 'R+Alt']]);
});

Deno.test('ui-nav: a file that is not a navigation object is a warning', () => {
  const nav = resolveNav([ui, { source: 'odd', layer: [] as never }, { source: 'odd2', layer: { sidebar: 'x' as never } }], [], user);
  assertEquals(nav.warnings, ['odd: not a navigation object', 'odd2: sidebar is not a list']);
});

Deno.test('ui-nav: panels put a module route in a shell page, by slot and order', () => {
  const archive: NamedLayer = {
    source: 'archive',
    layer: {
      panels: [
        { id: 'archive.life-events', slot: 'stats.sections', label: 'Events', route: '/stats/life-events', order: 20 },
        { id: 'archive.duplicates', slot: 'nodes.tools', label: 'Duplicates', icon: 'copy', route: '/duplicates?path={path}' },
        { id: 'archive.half', slot: 'nodes.tools', label: 'No route' },
      ],
    },
  };
  const ems: NamedLayer = { source: 'ems', layer: { panels: [{ id: 'ems.status', slot: 'stats.sections', label: 'Media service', route: '/ems', order: 10 }] } };
  const nav = resolveNav([archive, ems], [{ source: '/etc/ui/nav.json', layer: { hide: ['archive.duplicates'] } }], admin);
  assertEquals(nav.panels.map((panel) => panel.id), ['ems.status', 'archive.life-events']);
  assertEquals(nav.warnings, ['archive.half: no route']);
});
