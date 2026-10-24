import { assert, assertEquals } from '@std/assert';
import { buildLayoutResponse, encodeLayoutIndex, SEARCH_LAYOUT_MAX_JSON_BYTES } from '../layout.ts';

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const OWNERSHIP = { mode: 0o750, uid: 3000, gid: 1002 };

Deno.test('layout index dictionaries remove repeated directories, mimetypes and ownerships', () => {
  const layout = encodeLayoutIndex([
    {
      path: `/archive/albums/trip/files/a.jpg`,
      name: 'a.jpg',
      kind: 'photo',
      mimetype: 'image/jpeg',
      takenAt: '2020-01-01T10:00:00',
      width: 4000,
      height: 3000,
      ownership: OWNERSHIP,
    },
    {
      path: `/archive/albums/trip/files/b.jpg`,
      memberPath: `/archive/albums/auto/member-b`,
      name: 'A better name',
      kind: 'photo',
      mimetype: 'image/jpeg',
      ownership: { ...OWNERSHIP },
    },
    {
      path: `/archive/albums/trip/files/c.jpg`,
      name: 'c.jpg',
      kind: 'photo',
      mimetype: 'image/jpeg',
      ownership: { ...OWNERSHIP, acl: [{ mode: 0o6, uid: 3001 }] },
      pinned: true,
    },
  ]);

  assertEquals(layout.directories, [`/archive/albums/trip/files`, `/archive/albums/auto`]);
  assertEquals(layout.mimetypes, ['image/jpeg']);
  assertEquals(layout.ownerships, [OWNERSHIP, { ...OWNERSHIP, acl: [{ mode: 0o6, uid: 3001 }] }]);
  assertEquals(layout.items[0], [0, 'a.jpg', -1, '', '', 0, 0, '2020-01-01T10:00:00', 4000, 3000, 0, 0, 0, 0, 0, 0]);
  assertEquals(layout.items[1], [0, 'b.jpg', 1, 'member-b', 'A better name', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEquals(layout.items[2].slice(14), [1, 1]);
});

Deno.test('a representative 20,000-item layout response stays within its wire budget', () => {
  const items = Array.from({ length: 20_000 }, (_, index) => ({
    path: `/archive/albums/large/files/IMG_${String(index).padStart(5, '0')}.jpg`,
    name: `IMG_${String(index).padStart(5, '0')}.jpg`,
    kind: 'photo' as const,
    mimetype: 'image/jpeg',
    takenAt: `2020-01-${String(index % 28 + 1).padStart(2, '0')}T10:00:00`,
    width: 4000,
    height: 3000,
    ownership: OWNERSHIP,
  }));

  const response = buildLayoutResponse(items, false);
  const bytes = jsonBytes(response);
  assertEquals(response.truncated, false);
  assert(bytes <= SEARCH_LAYOUT_MAX_JSON_BYTES, `layout response is ${bytes} bytes`);
});

Deno.test('an oversized layout returns the small paged-fallback signal', () => {
  // 200-byte basenames are legal and expose why an item-count ceiling alone is
  // not a transport bound. A distinct display name makes the row representative
  // of imported media whose title differs from its filename.
  const items = Array.from({ length: 20_000 }, (_, index) => {
    const suffix = String(index).padStart(5, '0');
    const basename = `${'f'.repeat(190)}-${suffix}.jpg`;
    return {
      path: `/archive/albums/large/files/${basename}`,
      name: `${'N'.repeat(190)} ${suffix}`,
      kind: 'photo' as const,
      mimetype: 'image/jpeg',
      takenAt: '2020-01-01T10:00:00',
      width: 4000,
      height: 3000,
      ownership: OWNERSHIP,
    };
  });
  const unbounded = {
    truncated: false,
    cursor: null,
    offset: 0,
    layout: encodeLayoutIndex(items),
  };
  assert(jsonBytes(unbounded) > 4 * 1024 * 1024, 'fixture must reproduce the API capture failure');

  const response = buildLayoutResponse(items, false);
  assertEquals(response, {
    truncated: true,
    cursor: null,
    offset: 0,
    layout: { directories: [], mimetypes: [], ownerships: [], items: [] },
  });
  assert(jsonBytes(response) <= SEARCH_LAYOUT_MAX_JSON_BYTES);
});

Deno.test('an item-truncated source skips an unusable layout prefix', () => {
  assertEquals(buildLayoutResponse([], true), {
    truncated: true,
    cursor: null,
    offset: 0,
    layout: { directories: [], mimetypes: [], ownerships: [], items: [] },
  });
});

Deno.test('renditions travel as a list beside the rows, and only when asked for', () => {
  const item = (name: string, hasDerivatives?: boolean) => ({
    path: `/home/anna/staging/files/${name}`,
    name,
    kind: 'photo' as const,
    mimetype: 'image/jpeg',
    ownership: OWNERSHIP,
    ...(hasDerivatives === undefined ? {} : { hasDerivatives }),
  });

  const asked = encodeLayoutIndex([item('a.jpg', true), item('b.jpg', false)]);
  assertEquals(asked.derivatives, [1, 0]);
  // The rows keep their sixteen columns either way.
  assertEquals(asked.items.map((row) => row.length), [16, 16]);

  const plain = encodeLayoutIndex([item('a.jpg'), item('b.jpg')]);
  assertEquals('derivatives' in plain, false);
});
