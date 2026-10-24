import { assertEquals, assertThrows } from '@std/assert';
import { decodeSearchLayout, type SearchLayoutIndex } from '../search-layout.ts';

const OWNERSHIP = { mode: 0o750, uid: 3000, gid: 1002 };

Deno.test('decodes dictionary paths and compact optional fields', () => {
  const layout: SearchLayoutIndex = {
    directories: [`/archive/albums/trip/files`, `/archive/albums/auto`],
    mimetypes: ['image/jpeg', 'video/mp4'],
    ownerships: [OWNERSHIP, { mode: 0o770, uid: 3001, gid: 1002 }],
    items: [
      [0, 'a.jpg', -1, '', '', 0, 0, '2020-01-01T10:00:00', 4000, 3000, 90, 0, 3, 0, 0, 0],
      [0, 'b.mp4', 1, 'member-b', 'The clip', 1, 1, '', 1440, 1080, 0, 12.5, 0, 1.333333, 1, 1],
    ],
  };

  assertEquals(decodeSearchLayout(layout), [
    {
      path: `/archive/albums/trip/files/a.jpg`,
      memberPath: undefined,
      kind: 'photo',
      type: 'file',
      name: 'a.jpg',
      mimetype: 'image/jpeg',
      takenAt: '2020-01-01T10:00:00',
      score: 1,
      width: 4000,
      height: 3000,
      angle: 90,
      duration: undefined,
      stackCount: 3,
      sar: undefined,
      ownership: OWNERSHIP,
      pinned: undefined,
    },
    {
      path: `/archive/albums/trip/files/b.mp4`,
      memberPath: `/archive/albums/auto/member-b`,
      kind: 'video',
      type: 'file',
      name: 'The clip',
      mimetype: 'video/mp4',
      takenAt: undefined,
      score: 1,
      width: 1440,
      height: 1080,
      angle: undefined,
      duration: 12.5,
      stackCount: undefined,
      // The anamorphic case the trailing field exists for: a 1440x1080 raster of a 16:9
      // picture, which the grid must lay out at 16:9 rather than measure and reflow.
      sar: 1.333333,
      ownership: { mode: 0o770, uid: 3001, gid: 1002 },
      pinned: true,
    },
  ]);
});

Deno.test('a row from a server that does not send the pin reads as not pinned', () => {
  const [item] = decodeSearchLayout({
    directories: ['/a'],
    mimetypes: ['image/jpeg'],
    ownerships: [OWNERSHIP],
    items: [[0, 'a.jpg', -1, '', '', 0, 0, '', 0, 0, 0, 0, 0, 0, 0] as unknown as SearchLayoutIndex['items'][number]],
  });
  assertEquals(item.pinned, undefined);
});

Deno.test('rejects an invalid layout dictionary index', () => {
  assertThrows(
    () => decodeSearchLayout({ directories: [], mimetypes: ['image/jpeg'], ownerships: [OWNERSHIP], items: [[2, 'a.jpg', -1, '', '', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0]] }),
    Error,
    'invalid search layout dictionary index',
  );
  assertThrows(
    () => decodeSearchLayout({ directories: ['/a'], mimetypes: ['image/jpeg'], ownerships: [OWNERSHIP], items: [[0, 'a.jpg', -1, '', '', 0, 0, '', 0, 0, 0, 0, 0, 0, 1, 0]] }),
    Error,
    'invalid search layout dictionary index',
  );
});

Deno.test('the renditions list beside the rows says which files have renditions', () => {
  const rows: SearchLayoutIndex['items'] = [
    [0, 'a.jpg', -1, '', '', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 'b.jpg', -1, '', '', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const asked = decodeSearchLayout({ directories: ['/a'], mimetypes: ['image/jpeg'], ownerships: [OWNERSHIP], items: rows, derivatives: [1, 0] });
  assertEquals(asked.map((item) => item.hasDerivatives), [true, false]);

  // A sixteen-column row from a layout that was not asked for renditions decodes as before.
  const plain = decodeSearchLayout({ directories: ['/a'], mimetypes: ['image/jpeg'], ownerships: [OWNERSHIP], items: rows });
  assertEquals(plain.map((item) => 'hasDerivatives' in item), [false, false]);
  assertEquals(plain.map((item) => item.path), ['/a/a.jpg', '/a/b.jpg']);
});

Deno.test('a trailing column this decoder does not know is ignored', () => {
  const [item] = decodeSearchLayout({
    directories: ['/a'],
    mimetypes: ['image/jpeg'],
    ownerships: [OWNERSHIP],
    items: [[0, 'a.jpg', -1, '', '', 0, 0, '', 4000, 3000, 0, 0, 0, 0, 0, 1, 7] as unknown as SearchLayoutIndex['items'][number]],
  });
  assertEquals([item.width, item.height, item.pinned], [4000, 3000, true]);
});
