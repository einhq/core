import { assertEquals } from '@std/assert';
import type { NodeChildEntry } from '../node-entry.ts';
import { entriesToTreeNodes, sortEntries } from '../node-sort.ts';
import { openTargetFor } from '../node-route.ts';

const entry = (name: string, type: string, extra: { size?: number; mimetype?: string; modtime?: number; childCount?: number } = {}): NodeChildEntry => ({
  name,
  childCount: extra.childCount ?? 0,
  node: {
    id: name,
    type,
    props: {
      uid: 1000,
      gid: 1000,
      mode: 0o775,
      count: 1,
      birthtime: { uid: 1000, timestamp: 0 },
      changetime: { uid: 1000, timestamp: 0 },
      modtime: { uid: 1000, timestamp: extra.modtime ?? 0 },
    },
    attrs: { size: extra.size, mimetype: extra.mimetype },
  },
});

import { nodeRoutes } from '../../signals/module-ui.ts';

Deno.test('node sort: containers first, then numeric-aware names', () => {
  const sorted = sortEntries([entry('b.jpg', 'file'), entry('10', 'directory'), entry('2', 'directory'), entry('a.jpg', 'file')], { key: 'name', dir: 'asc' });
  assertEquals(sorted.map((e) => e.name), ['2', '10', 'a.jpg', 'b.jpg']);
  const desc = sortEntries(sorted, { key: 'name', dir: 'desc' });
  assertEquals(desc.map((e) => e.name), ['10', '2', 'b.jpg', 'a.jpg']);
});

Deno.test('node sort: size and modified sink missing values, ties fall back to name', () => {
  const bySize = sortEntries([entry('c', 'file', { size: 5 }), entry('b', 'file'), entry('a', 'file', { size: 5 })], { key: 'size', dir: 'asc' });
  assertEquals(bySize.map((e) => e.name), ['a', 'c', 'b']);
  const byTime = sortEntries([entry('old', 'file', { modtime: 1 }), entry('new', 'file', { modtime: 2 })], { key: 'modified', dir: 'desc' });
  assertEquals(byTime.map((e) => e.name), ['new', 'old']);
});

Deno.test('node sort: tree nodes are keyed by absolute path and flag children', () => {
  const nodes = entriesToTreeNodes([entry('x', 'directory', { childCount: 2 }), entry('y', 'file')], '/', { key: 'name', dir: 'asc' });
  assertEquals(nodes.map((n) => [n.value, n.hasChildren]), [['/x', true], ['/y', false]]);
  assertEquals(entriesToTreeNodes([entry('z', 'file')], '/a/b', { key: 'name', dir: 'asc' })[0].value, '/a/b/z');
});

Deno.test('node route: open targets per node type', () => {
  // What archive's `ui.open` gives; a type no module names is not a route.
  nodeRoutes.value = { album: '/albums/{path}', person: '/people/{name}' };
  const owner = { uid: 1000, gids: [1000] };
  const other = { uid: 2000, gids: [2000] };
  assertEquals(openTargetFor(entry('Jul', 'album'), '/archive/albums/Jul', null), { kind: 'route', to: '/albums/%2Farchive%2Falbums%2FJul' });
  assertEquals(openTargetFor(entry('anna', 'person'), '/archive/people/anna', null), { kind: 'route', to: '/people/anna' });
  assertEquals(openTargetFor(entry('a.jpg', 'file', { mimetype: 'image/jpeg' }), '/x/a.jpg', null), { kind: 'lightbox' });
  assertEquals(openTargetFor(entry('a b.txt', 'file', { mimetype: 'text/plain' }), '/x/a b.txt', owner), { kind: 'editor', readOnly: false });
  assertEquals(openTargetFor(entry('run', 'file', { mimetype: 'text/x-shellscript' }), '/x/run', other), { kind: 'editor', readOnly: true });
  assertEquals(openTargetFor(entry('deno.jsonc', 'file', { mimetype: 'application/octet-stream' }), '/x/deno.jsonc', null), { kind: 'editor', readOnly: true });
  assertEquals(openTargetFor(entry('a b.pdf', 'file', { mimetype: 'application/pdf' }), '/x/a b.pdf', null), { kind: 'file', url: '/file/x/a%20b.pdf' });
  assertEquals(openTargetFor(entry('q', 'queue'), '/var/queues/q', null), { kind: 'none' });
});

Deno.test('node sort: names starting with a dot are left out unless asked for', () => {
  const entries = [entry('.cache', 'directory'), entry('photos', 'directory'), entry('.env', 'file')];
  const root = { key: 'name', dir: 'asc' } as const;
  assertEquals(entriesToTreeNodes(entries, '/home/anna', root, { showHidden: false }).map((n) => n.label), ['photos']);
  assertEquals(entriesToTreeNodes(entries, '/home/anna', root, { showHidden: true }).map((n) => n.label), ['.cache', 'photos', '.env']);
});

Deno.test('node sort: a node that may not be listed gets no chevron', () => {
  const nodes = entriesToTreeNodes([entry('open', 'directory', { childCount: 2 }), entry('locked', 'directory', { childCount: 2 })], '/', { key: 'name', dir: 'asc' }, {
    listable: (e) => e.name !== 'locked',
  });
  assertEquals(nodes.map((n) => [n.label, n.hasChildren]), [['locked', false], ['open', true]]);
});
