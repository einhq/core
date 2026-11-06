import { assertEquals } from '@std/assert';
import { type NamedLayer, type NavLayer, resolveNav } from '@ui/nav';
import { accepts, emptyLayer, movableEntry, moveEntry, type Placed, placedOf, resetArrangement, writeOwnNavScript } from '../nav-arrange.ts';

const shell: NamedLayer = {
  source: 'ui',
  layer: {
    sections: [{ id: 'main', order: 10 }, { id: 'browse', label: 'Browse', order: 20 }],
    sidebar: [
      { id: 'ui.home', section: 'main', label: 'Home', icon: 'home', to: '/', order: 10 },
      { id: 'ui.albums', section: 'browse', label: 'Albums', icon: 'photo', to: '/albums', order: 10 },
      { id: 'ui.people', section: 'browse', label: 'People', icon: 'users', to: '/people', order: 20 },
    ],
    topbar: [
      { id: 'ui.create', title: 'Create', icon: 'plus', order: 20 },
      { id: 'ui.create.album', parent: 'ui.create', title: 'Album', icon: 'photo', action: { dialog: '/albums/new' } },
      { id: 'ui.chat', title: 'Chat', icon: 'message-circle', action: { drawer: '/chat' }, order: 10 },
      { id: 'ui.account', title: 'Account', icon: 'user', order: 1000 },
      { id: 'ui.trash', parent: 'ui.account', title: 'Trash', icon: 'trash', action: { navigate: '/trash' }, order: 910 },
      { id: 'ui.random', title: 'Random', icon: 'arrows-shuffle', action: { run: 'album-random', navigate: '/albums/{path}' }, place: 'search' },
    ],
  },
};
const reader = { admin: false, guest: false };
const draw = (mine: NavLayer) => resolveNav([shell], [{ source: '~/.ui/nav.json', layer: mine }], reader);
const placed = (nav: ReturnType<typeof draw>) => ({
  sections: nav.sections.map((section) => [section.id, section.items.map((item) => item.id)]),
  topbar: nav.topbar.map((entry) => entry.menu ? [entry.id, entry.menu.map((row) => row.id)] : entry.id),
});
const at = (nav: ReturnType<typeof draw>, section: string): Placed[] => nav.sections.find((s) => s.id === section)!.items.map((link) => placedOf(link, 'sidebar'));

Deno.test('a page dropped in the top bar is a button there, between its neighbours, and only its place and order are written', () => {
  const nav = draw({});
  const bar = nav.topbar.filter((entry) => entry.id !== 'ui.account' && entry.place !== 'search').map((entry) => placedOf(entry, 'topbar'));
  const albums = at(nav, 'browse')[0];
  const mine = moveEntry({}, albums, { kind: 'topbar' }, bar, 1);
  assertEquals(mine, { sidebar: [{ id: 'ui.albums', place: 'topbar', parent: null, order: 15 }] });
  assertEquals(placed(draw(mine)), {
    sections: [['main', ['ui.home']], ['browse', ['ui.people']]],
    topbar: ['ui.chat', 'ui.albums', ['ui.create', ['ui.create.album']], ['ui.account', ['ui.trash']], 'ui.random'],
  });
});

Deno.test('a top-bar entry dropped in a section, and an account row taken out to the sidebar, are links there', () => {
  let mine: NavLayer = { hide: ['ui.people'] };
  const chat = placedOf(draw(mine).topbar.find((entry) => entry.id === 'ui.chat')!, 'topbar');
  mine = moveEntry(mine, chat, { kind: 'section', section: 'main' }, at(draw(mine), 'main'), 0);
  const trash = placedOf(draw(mine).topbar.find((entry) => entry.id === 'ui.account')!.menu![0], 'topbar');
  mine = moveEntry(mine, trash, { kind: 'section', section: 'browse' }, at(draw(mine), 'browse'), 1);
  assertEquals(mine, {
    hide: ['ui.people'],
    topbar: [{ id: 'ui.chat', section: 'main', place: 'sidebar', parent: null, order: 0 }, { id: 'ui.trash', section: 'browse', place: 'sidebar', parent: null, order: 20 }],
  });
  assertEquals(placed(draw(mine)).sections, [['main', ['ui.chat', 'ui.home']], ['browse', ['ui.albums', 'ui.trash']]]);
});

Deno.test('a page dropped in the account menu is a row of it', () => {
  const nav = draw({});
  const account = nav.topbar.find((entry) => entry.id === 'ui.account')!;
  const mine = moveEntry({}, at(nav, 'main')[0], { kind: 'menu', parent: 'ui.account' }, account.menu!.map((row) => placedOf(row, 'topbar')), 1);
  assertEquals(placed(draw(mine)).topbar.slice(2, 3), [['ui.account', ['ui.trash', 'ui.home']]]);
});

Deno.test('with no whole number between the neighbours, the spot is numbered afresh by tens', () => {
  const tied: NavLayer = { sidebar: [{ id: 'ui.albums', order: 20 }] };
  const nav = draw(tied);
  // Albums and People both at 20; Home goes between them.
  const mine = moveEntry(tied, at(nav, 'main')[0], { kind: 'section', section: 'browse' }, at(nav, 'browse'), 1);
  assertEquals(placed(draw(mine)).sections, [['main', []], ['browse', ['ui.albums', 'ui.home', 'ui.people']]]);
  assertEquals(mine.sidebar, [
    { id: 'ui.albums', order: 10 },
    { id: 'ui.home', section: 'browse', place: null, parent: null, order: 20 },
    { id: 'ui.people', order: 30 },
  ]);
});

Deno.test('moving an entry down its own spot counts it where it stood', () => {
  const nav = draw({});
  const browse = at(nav, 'browse');
  // Dropped before what follows People: the end, past People.
  const mine = moveEntry({}, browse[0], { kind: 'section', section: 'browse' }, browse, 2);
  assertEquals(placed(draw(mine)).sections[1], ['browse', ['ui.people', 'ui.albums']]);
});

Deno.test('a command or a dropdown goes nowhere in the sidebar, and a dropdown into no dropdown', () => {
  const nav = draw({});
  const of = (id: string) => movableEntry(nav.topbar.find((entry) => entry.id === id)!);
  const section = { kind: 'section', section: 'main' } as const;
  const menu = { kind: 'menu', parent: 'ui.account' } as const;
  assertEquals([accepts(section, of('ui.chat')), accepts(section, of('ui.random')), accepts(section, of('ui.create'))], [true, false, false]);
  assertEquals([accepts(menu, of('ui.chat')), accepts(menu, of('ui.create')), accepts({ kind: 'topbar' }, of('ui.create'))], [true, false, true]);
});

Deno.test('resetting takes away the places and orders, and keeps what else the overlay says', () => {
  const mine: NavLayer = {
    hide: ['ui.people'],
    sidebar: [{ id: 'ui.albums', place: 'topbar', order: 15, label: 'Photo albums' }, { id: 'ui.home', section: 'browse' }],
    topbar: [{ id: 'ui.chat', parent: 'ui.account' }],
  };
  assertEquals(resetArrangement(mine), { hide: ['ui.people'], sidebar: [{ id: 'ui.albums', label: 'Photo albums' }] });
  assertEquals(emptyLayer(resetArrangement({ sidebar: [{ id: 'ui.albums', order: 5 }] })), true);
  assertEquals(writeOwnNavScript({}), 'rm -f ~/.ui/nav.json');
});
