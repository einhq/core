/**
 * Shared NodeQuery conformance suite.
 *
 * Parameterized over a VFS factory so the in-memory store (fast tier) and
 * PgStore (PG tier) are held to identical semantics. The memory evaluator in
 * `src/vfs/query-eval.ts` is the reference; any divergence in the SQL builder
 * shows up here.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import type { Access } from '../../lib/access/types.ts';
import type { AttrRef, NodeQueryCursor, NodeQueryEntry, NodeQueryOrder, NodeVFS } from '../../vfs/mod.ts';

export type QueryVfsFactory = () => Promise<{ vfs: NodeVFS; dispose: () => Promise<void> }>;

const TAKEN_AT: AttrRef = { coalesce: ['takenAtManual', 'takenAt'] };

/** Media fixtures spanning years, kinds, overrides and derived renditions. */
const FIXTURES = [
  { name: 'a.jpg', attrs: { mimetype: 'image/jpeg', takenAt: '1995-06-01T10:00:00' } },
  { name: 'b.jpg', attrs: { mimetype: 'image/jpeg', takenAt: '1998-03-12T08:30:00' } },
  { name: 'c.png', attrs: { mimetype: 'image/png', takenAt: '2001-01-01T00:00:00' } },
  { name: 'd.mp4', attrs: { mimetype: 'video/mp4', takenAt: '1998-11-20T22:00:00' } },
  { name: 'e.mp4', attrs: { mimetype: 'video/mp4', takenAt: '2010-05-05T12:00:00' } },
  // takenAtManual must win over takenAt wherever the coalesce ref is used.
  { name: 'f.jpg', attrs: { mimetype: 'image/jpeg', takenAt: '2020-01-01T00:00:00', takenAtManual: '1996-07-07T07:07:07' } },
  // A generated rendition: excluded by `derived != true`.
  { name: 'thumb.webp', attrs: { mimetype: 'image/webp', takenAt: '1998-03-12T08:30:00', derived: true } },
  // No takenAt at all: excluded whenever the query orders by it.
  { name: 'undated.jpg', attrs: { mimetype: 'image/jpeg' } },
];

const names = (entries: { absPath: string }[]) => entries.map((e) => e.absPath.split('/').pop());

export async function runQueryConformance(t: Deno.TestContext, factory: QueryVfsFactory) {
  const { vfs, dispose } = await factory();

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });
    for (const fixture of FIXTURES) {
      await vfs.create(ADMIN_ACCESS, 'file', '/media', fixture.name, {
        props: { mode: 0o644 },
        attrs: fixture.attrs,
      });
    }

    await t.step('range on a coalesced ref honours the override', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [
          { ref: TAKEN_AT, op: 'gte', value: '1995' },
          { ref: TAKEN_AT, op: 'lt', value: '1999' },
        ],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });

      // f.jpg has takenAt 2020 but takenAtManual 1996, so it sorts into 1996.
      //
      // b.jpg and thumb.webp deliberately share a takenAt (the paging step below depends on
      // it), so their relative order falls to the id tiebreak — and ids are ULIDs, whose
      // random suffix decides whenever both were created within the same millisecond. The
      // tied pair is asserted as a set, which is all the query guarantees.
      const ordered = names(entries);
      assertEquals(ordered.length, 5);
      assertEquals([ordered[0], ordered[1], ordered[4]], ['a.jpg', 'f.jpg', 'd.mp4']);
      assertEquals([ordered[2], ordered[3]].slice().sort(), ['b.jpg', 'thumb.webp']);
    });

    await t.step('ne treats a missing attr as not-equal', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [
          { ref: TAKEN_AT, op: 'gte', value: '1998' },
          { ref: TAKEN_AT, op: 'lt', value: '1999' },
          { ref: 'derived', op: 'ne', value: true },
        ],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });

      // thumb.webp is derived; b.jpg and d.mp4 have no `derived` attr at all
      // and must still pass.
      assertEquals(names(entries), ['b.jpg', 'd.mp4']);
    });

    await t.step('eq is strict about missing attrs', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'derived', op: 'eq', value: true }],
        limit: 50,
      });
      assertEquals(names(entries), ['thumb.webp']);
    });

    await t.step('prefix matches a mimetype family', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [
          { ref: 'mimetype', op: 'prefix', value: 'video/' },
          { ref: 'derived', op: 'ne', value: true },
        ],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });
      assertEquals(names(entries), ['d.mp4', 'e.mp4']);
    });

    await t.step('in matches any listed value', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'mimetype', op: 'in', value: ['image/png', 'video/mp4'] }],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });
      assertEquals(names(entries), ['d.mp4', 'c.png', 'e.mp4']);
    });

    await t.step('exists and missing', async () => {
      const missing = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'takenAt', op: 'missing' }],
        limit: 50,
      });
      assertEquals(names(missing), ['undated.jpg']);

      const exists = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'takenAtManual', op: 'exists' }],
        limit: 50,
      });
      assertEquals(names(exists), ['f.jpg']);
    });

    await t.step('rows without the ordering attr are excluded, not sorted to an end', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: TAKEN_AT, dir: 'desc' },
        limit: 50,
      });
      assertEquals(entries.some((e) => e.absPath.endsWith('undated.jpg')), false);
      // Unordered, the same node is reachable.
      const unordered = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'takenAt', op: 'missing' }],
        limit: 50,
      });
      assertEquals(unordered.length, 1);
    });

    await t.step('descending order reverses ascending', async () => {
      const asc = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });
      const desc = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: TAKEN_AT, dir: 'desc' },
        limit: 50,
      });
      assertEquals(names(desc), names(asc).reverse());
    });

    await t.step('limit is respected', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 2,
      });
      assertEquals(names(entries), ['a.jpg', 'f.jpg']);
    });

    await t.step('keyset paging covers every row exactly once', async () => {
      const all = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 50,
      });

      const paged: string[] = [];
      let cursor: { value: string | null; id: string } | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page: Awaited<ReturnType<NodeVFS['query']>> = await vfs.query(ADMIN_ACCESS, {
          types: ['file'],
          orderBy: { ref: TAKEN_AT, dir: 'asc' },
          after: cursor,
          limit: 2,
        });
        if (page.length === 0) break;
        paged.push(...page.map((e) => e.absPath));
        const last = page[page.length - 1];
        cursor = { value: last.sortValue, id: last.id };
      }

      assertEquals(paged, all.map((e) => e.absPath));
      assertEquals(new Set(paged).size, paged.length);
    });

    await t.step('paging is stable across duplicate sort values', async () => {
      // b.jpg and thumb.webp share a takenAt, so only the id tiebreak keeps
      // the cursor total.
      const dupes = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: TAKEN_AT, op: 'eq', value: '1998-03-12T08:30:00' }],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        limit: 1,
      });
      assertEquals(dupes.length, 1);

      const next = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: TAKEN_AT, op: 'eq', value: '1998-03-12T08:30:00' }],
        orderBy: { ref: TAKEN_AT, dir: 'asc' },
        after: { value: dupes[0].sortValue, id: dupes[0].id },
        limit: 5,
      });
      assertEquals(next.length, 1);
      assertEquals(next[0].id === dupes[0].id, false);
    });

    await t.step('query rows carry no hierarchy', async () => {
      const entries = await vfs.query(ADMIN_ACCESS, { types: ['directory'], limit: 10 });
      const media = entries.find((e) => e.absPath === '/media');
      assertEquals(media?.node.props.count, 0);
    });

    await t.step('nested attrs can be filtered, ordered, grouped, and summed', async () => {
      const relationFrom: AttrRef = { path: ['relation', 'from'] };
      const relationAmount: AttrRef = { path: ['relation', 'amount'] };

      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'relations', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/relations', 'old', {
        props: { mode: 0o644 },
        attrs: { relation: { from: '1992-08-01', amount: 2 } },
      });
      await vfs.create(ADMIN_ACCESS, 'file', '/relations', 'new', {
        props: { mode: 0o644 },
        attrs: { relation: { from: '2003-04-15', amount: 3 } },
      });
      await vfs.create(ADMIN_ACCESS, 'file', '/relations', 'undated', {
        props: { mode: 0o644 },
        attrs: { relation: { from: null, amount: 5 }, legacyFrom: '1999-01-01' },
      });

      const entries = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: relationFrom, op: 'gte', value: '1990' }],
        orderBy: { ref: relationFrom, dir: 'asc' },
        limit: 50,
      });
      assertEquals(names(entries), ['old', 'new']);
      assertEquals(entries.map((entry) => entry.sortValue), ['1992-08-01', '2003-04-15']);

      const withFallback = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        orderBy: { ref: { coalesce: [relationFrom, 'legacyFrom'] }, dir: 'asc' },
        limit: 50,
      });
      assertEquals(names(withFallback), ['old', 'undated', 'new']);

      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: relationFrom, op: 'exists' }],
        group: [{ ref: relationFrom, prefixLength: 4 }],
        sum: relationAmount,
      });
      assertEquals(buckets, [
        { key: ['1992'], count: 1, sum: 2 },
        { key: ['2003'], count: 1, sum: 3 },
      ]);
    });

    await t.step('nested attr paths validate every segment', async () => {
      await assertRejects(() =>
        vfs.query(ADMIN_ACCESS, {
          where: [{ ref: { path: ['relation', "from' OR true --"] }, op: 'exists' }],
          limit: 10,
        })
      );
      await assertRejects(() =>
        vfs.query(ADMIN_ACCESS, {
          where: [{ ref: { path: [] }, op: 'exists' }],
          limit: 10,
        })
      );
    });

    await t.step('aggregate buckets by year', async () => {
      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'derived', op: 'ne', value: true }],
        group: [{ ref: TAKEN_AT, prefixLength: 4 }],
      });

      assertEquals(buckets, [
        { key: ['1995'], count: 1 },
        { key: ['1996'], count: 1 },
        { key: ['1998'], count: 2 },
        { key: ['2001'], count: 1 },
        { key: ['2010'], count: 1 },
      ]);
    });

    await t.step('aggregate groups by multiple attr dimensions', async () => {
      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'derived', op: 'ne', value: true }],
        group: [{ ref: 'mimetype' }, { ref: TAKEN_AT, prefixLength: 4 }],
      });

      assertEquals(buckets, [
        { key: ['image/jpeg', '1995'], count: 1 },
        { key: ['image/jpeg', '1996'], count: 1 },
        { key: ['image/jpeg', '1998'], count: 1 },
        { key: ['image/png', '2001'], count: 1 },
        { key: ['video/mp4', '1998'], count: 1 },
        { key: ['video/mp4', '2010'], count: 1 },
      ]);
    });

    await t.step('aggregate reads an array attr element by element with each', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'labeled', { props: { mode: 0o755 } });
      const labeled: [string, unknown][] = [
        ['one.jpg', ['sea', 'sky', 'boat']],
        // A repeated element counts the node once.
        ['two.jpg', ['sea', 'sea']],
        // A scalar counts under itself.
        ['three.jpg', 'boat'],
        // An empty array and a null element add nothing.
        ['four.jpg', []],
        ['five.jpg', [null, 'sky']],
        ['six.jpg', undefined],
      ];
      for (const [name, labels] of labeled) {
        await vfs.create(ADMIN_ACCESS, 'file', '/labeled', name, {
          props: { mode: 0o644 },
          attrs: { fixture: 'each', mimetype: name === 'one.jpg' ? 'image/png' : 'image/jpeg', ...(labels === undefined ? {} : { labels }) },
        });
      }

      const where = [{ ref: 'fixture', op: 'eq' as const, value: 'each' }];
      assertEquals(await vfs.aggregate(ADMIN_ACCESS, { where, group: [{ ref: 'labels', each: true }] }), [
        { key: ['boat'], count: 2 },
        { key: ['sea'], count: 2 },
        { key: ['sky'], count: 2 },
      ]);
      assertEquals(await vfs.aggregate(ADMIN_ACCESS, { where, group: [{ ref: 'mimetype' }, { ref: 'labels', each: true, prefixLength: 1 }] }), [
        { key: ['image/jpeg', 'b'], count: 1 },
        { key: ['image/jpeg', 's'], count: 2 },
        { key: ['image/png', 'b'], count: 1 },
        // `sea` and `sky` share the prefix: the node counts once under it.
        { key: ['image/png', 's'], count: 1 },
      ]);
    });

    await t.step('has matches an element of an array attr, or a scalar as one', async () => {
      // The nodes of the step above.
      const carrying = async (...values: string[]) =>
        names(
          await vfs.query(ADMIN_ACCESS, {
            where: [{ ref: 'fixture', op: 'eq', value: 'each' }, ...values.map((value) => ({ ref: 'labels', op: 'has' as const, value }))],
            limit: 50,
          }),
        ).sort();
      assertEquals(await carrying('sea'), ['one.jpg', 'two.jpg']);
      assertEquals(await carrying('boat'), ['one.jpg', 'three.jpg']);
      assertEquals(await carrying('sky'), ['five.jpg', 'one.jpg']);
      assertEquals(await carrying('sea', 'sky'), ['one.jpg']);
      // A whole element, not a part of one.
      assertEquals(await carrying('se'), []);
    });

    await t.step('aggregate buckets by node type', async () => {
      // Node type has no attr projection, so this is the only way to count it.
      // Unlike an attr group, nothing is excluded for a missing key: every node
      // has a type, so the buckets sum to the whole tree.
      const buckets = await vfs.aggregate(ADMIN_ACCESS, { group: [{ column: 'type' }] });
      const byType = Object.fromEntries(buckets.map((bucket) => [bucket.key[0], bucket.count]));

      const files = await vfs.query(ADMIN_ACCESS, { types: ['file'], limit: 1000 });
      assertEquals(byType.file, files.length);
      assertEquals(buckets.some((bucket) => bucket.key[0] === 'directory'), true);
    });

    await t.step('aggregate buckets by node id, beside an attr', async () => {
      // One bucket per node: every match's id and attr, without reading a node.
      const files = await vfs.query(ADMIN_ACCESS, { types: ['file'], where: [{ ref: 'mimetype', op: 'exists' }], limit: 1000 });
      const buckets = await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], group: [{ column: 'id' }, { ref: 'mimetype' }] });

      const byId = new Map(buckets.map((bucket) => [bucket.key[0], bucket]));
      assertEquals(byId.size, new Set(files.map((row) => row.id)).size);
      for (const row of files) assertEquals(byId.get(row.id), { key: [row.id, String(row.node.attrs.mimetype)], count: 1 });
    });

    await t.step('ids narrows an aggregate to the nodes asked about, and where still applies', async () => {
      const ids = new Map((await vfs.query(ADMIN_ACCESS, { types: ['file'], limit: 1000 })).map((row) => [names([row])[0], row.id]));
      const asked = ['a.jpg', 'b.jpg', 'c.png', 'undated.jpg'].map((name) => ids.get(name)!);
      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        ids: asked,
        where: [{ ref: 'takenAt', op: 'gte', value: '1996' }, { ref: 'takenAt', op: 'lt', value: '2000' }],
        group: [{ column: 'id' }],
      });
      assertEquals(buckets, [{ key: [ids.get('b.jpg')!], count: 1 }]);
      assertEquals(await vfs.aggregate(ADMIN_ACCESS, { ids: [], group: [{ column: 'id' }] }), []);
    });

    await t.step('aggregate by type honours where', async () => {
      const all = await vfs.aggregate(ADMIN_ACCESS, { group: [{ column: 'type' }] });
      const derived = await vfs.aggregate(ADMIN_ACCESS, {
        where: [{ ref: 'derived', op: 'eq', value: true }],
        group: [{ column: 'type' }],
      });

      const allFiles = all.find((bucket) => bucket.key[0] === 'file')?.count ?? 0;
      const derivedFiles = derived.find((bucket) => bucket.key[0] === 'file')?.count ?? 0;
      assertEquals(derivedFiles > 0 && derivedFiles < allFiles, true);
    });

    await t.step('batch path resolution matches resolveId, including hard links', async () => {
      const single = await vfs.resolveId(ADMIN_ACCESS, (await vfs.get(ADMIN_ACCESS, '/media/a.jpg')).id);
      const aId = single[0].id;

      // Hard-link one node under a second name: it must resolve to both paths.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'linked', { props: { mode: 0o755 } });
      await vfs.link(ADMIN_ACCESS, '/media/b.jpg', '/linked', 'b-alias.jpg');
      const bId = (await vfs.get(ADMIN_ACCESS, '/media/b.jpg')).id;

      const batch = await vfs.resolveIdPaths(ADMIN_ACCESS, [aId, bId]);

      assertEquals(batch.get(aId), ['/media/a.jpg']);
      assertEquals(batch.get(bId)?.slice().sort(), ['/linked/b-alias.jpg', '/media/b.jpg']);

      // Must agree with the per-id walk.
      const viaResolveId = (await vfs.resolveId(ADMIN_ACCESS, bId)).map((e) => e.absPath).sort();
      assertEquals(batch.get(bId)?.slice().sort(), viaResolveId);
    });

    await t.step('resolveId handles two hard links under the same parent', async () => {
      // The parent is resolved once and fans out over both names; a naive
      // implementation either drops one name or resolves the parent twice.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'twice', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/twice', 'first.jpg', { props: { mode: 0o644 } });
      const id = (await vfs.get(ADMIN_ACCESS, '/twice/first.jpg')).id;
      await vfs.link(ADMIN_ACCESS, '/twice/first.jpg', '/twice', 'second.jpg');

      const viaResolveId = (await vfs.resolveId(ADMIN_ACCESS, id)).map((e) => e.absPath).sort();
      assertEquals(viaResolveId, ['/twice/first.jpg', '/twice/second.jpg']);

      // The batched path must agree.
      const batched = await vfs.resolveIdPaths(ADMIN_ACCESS, [id]);
      assertEquals(batched.get(id)?.slice().sort(), viaResolveId);
    });

    await t.step('batch path resolution omits unknown ids rather than throwing', async () => {
      const batch = await vfs.resolveIdPaths(ADMIN_ACCESS, ['01ZZZZZZZZZZZZZZZZZZZZZZZZ']);
      assertEquals(batch.size, 0);
    });

    await t.step('findLinks resolves softlinks by their target', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'locations', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'location', '/locations', 'park');
      await vfs.create(ADMIN_ACCESS, 'location', '/locations', 'beach');

      // Own fixtures: the /media set includes a hard-linked file, which would
      // legitimately report its link under both of its paths.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'shots', { props: { mode: 0o755 } });
      for (const [file, location] of [['p1.jpg', 'park'], ['p2.jpg', 'park'], ['q.jpg', 'beach']]) {
        await vfs.create(ADMIN_ACCESS, 'file', '/shots', file, { props: { mode: 0o644 } });
        await vfs.create(ADMIN_ACCESS, 'softlink', `/shots/${file}`, 'location', {
          props: { mode: 0o777, softlink: `/locations/${location}` },
        });
      }

      const park = await vfs.findLinks(ADMIN_ACCESS, '/locations/park');
      assertEquals(park.map((l) => l.absPath).sort(), ['/shots/p1.jpg/location', '/shots/p2.jpg/location']);
      assertEquals(park.every((l) => l.target === '/locations/park'), true);

      // parentId is the holder of the link, which is what callers walk up to.
      const fileId = (await vfs.get(ADMIN_ACCESS, '/shots/p1.jpg')).id;
      assertEquals(park.find((l) => l.absPath.startsWith('/shots/p1.jpg'))?.parentId, fileId);

      assertEquals((await vfs.findLinks(ADMIN_ACCESS, ['/locations/park', '/locations/beach'])).length, 3);
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, '/locations/park', 1)).length, 1);
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, '/locations/nowhere')).length, 0);
    });

    await t.step('findLinksUnder covers a path and what lies under it, never a sibling sharing its prefix', async () => {
      // `-` and `.` sort before `/`, and `c` after it: a byte range that is off by one either way
      // takes one of them in.
      const targets = ['/sub/a', '/sub/a/b', '/sub/a/b/c', '/sub/a/b/c/d', '/sub/a/bc', '/sub/a/b-c', '/sub/a/b.c', '/sub/a0'];
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'pointers', { props: { mode: 0o755 } });
      for (const [i, target] of targets.entries()) {
        await vfs.create(ADMIN_ACCESS, 'softlink', '/pointers', `l${i}`, { props: { mode: 0o777, softlink: target } });
      }
      const under = async (paths: string[]) => (await vfs.findLinksUnder(ADMIN_ACCESS, paths, 100)).map((l) => l.target).sort();

      assertEquals(await under(['/sub/a/b']), ['/sub/a/b', '/sub/a/b/c', '/sub/a/b/c/d']);
      assertEquals(await under(['/sub/a/b/c', '/sub/a/bc']), ['/sub/a/b/c', '/sub/a/b/c/d', '/sub/a/bc']);
      assertEquals(await under(['/sub/a']), targets.slice(0, 7).sort());
      assertEquals(await under(['/sub/nowhere']), []);
      // `findLinks` takes the path itself only.
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, '/sub/a/b')).map((l) => l.target), ['/sub/a/b']);
    });

    await t.step('contains matches a substring, case-insensitively and literally', async () => {
      // Own directory and no mimetype, so these rows are invisible to every
      // other step — the counts above are exact.
      //
      // `DSCX4471` and `100 procent` exist to catch an unescaped value: as a
      // LIKE pattern `_` and `%` are wildcards, and each would pull in the
      // neighbour it is paired with. `nameless` has no `name` attr at all.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'named', { props: { mode: 0o755 } });
      for (
        const [node, name] of [
          ['dsc', 'DSC_4471.JPG'],
          ['wild', 'DSCX4471.JPG'],
          ['vasa', 'Vasaloppet 2011.jpg'],
          ['percent', '100% ren ull.jpg'],
          ['plain', '100 procent.jpg'],
          ['nameless', undefined],
        ] as const
      ) {
        await vfs.create(ADMIN_ACCESS, 'file', '/named', node, {
          props: { mode: 0o644 },
          attrs: name === undefined ? {} : { name },
        });
      }

      const matching = async (value: string) => {
        const entries = await vfs.query(ADMIN_ACCESS, {
          types: ['file'],
          where: [{ ref: 'name', op: 'contains', value }],
          limit: 50,
        });
        return names(entries).sort();
      };

      // Mid-string, and folded in both directions.
      assertEquals(await matching('loppet'), ['vasa']);
      assertEquals(await matching('VASALOPPET'), ['vasa']);
      assertEquals(await matching('.jpg'), ['dsc', 'percent', 'plain', 'vasa', 'wild']);

      // Metacharacters are text: `_` matches an underscore, not any character.
      assertEquals(await matching('C_4471'), ['dsc']);
      assertEquals(await matching('100%'), ['percent']);

      // A missing attr never matches, and neither does an absent substring.
      assertEquals(await matching('nameless'), []);
      assertEquals(await matching('kajakpaddling'), []);
    });

    await t.step('a match order ranks the name, the name and an extension, a prefix, a substring, then the rest', async () => {
      // `dotted` is the text and two extensions, so only a prefix. Folded on both sides.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'ranked', { props: { mode: 0o755 } });
      for (
        const [node, name] of [
          ['inside', 'Sommarseglats.JPG'],
          ['prefix', 'Seglatsen 2011.jpg'],
          ['dotted', 'seglats.tar.gz'],
          ['stem', 'SEGLATS.jpg'],
          ['exact', 'seglats'],
          ['other', 'Kajak.jpg'],
          ['nameless', undefined],
        ] as const
      ) {
        await vfs.create(ADMIN_ACCESS, 'file', '/ranked', node, {
          props: { mode: 0o644 },
          attrs: { group: 'ranked', ...(name === undefined ? {} : { name }) },
        });
      }
      const where = [{ ref: 'group', op: 'eq' as const, value: 'ranked' }];
      const ranked = async (order: NodeQueryOrder, limit = 50, after?: NodeQueryCursor) =>
        await vfs.query(ADMIN_ACCESS, { types: ['file'], where, orderBy: order, limit, after });

      const best = await ranked({ ref: 'name', dir: 'asc', match: 'Seglats' });
      assertEquals(best.map((entry) => entry.sortValue), ['0', '0', '1', '1', '2', '3']);
      assertEquals(names(best.slice(0, 2)).sort(), ['exact', 'stem']);
      assertEquals(names(best.slice(2, 4)).sort(), ['dotted', 'prefix']);
      assertEquals(names(best.slice(4)), ['inside', 'other']);

      const worst = await ranked({ ref: 'name', dir: 'desc', match: 'seglats' });
      assertEquals(names(worst.slice(0, 2)), ['other', 'inside']);

      // Paged by the rank and the id, the pages together are the one ordered list.
      const paged: string[] = [];
      let after: NodeQueryCursor | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await ranked({ ref: 'name', dir: 'asc', match: 'seglats' }, 2, after);
        paged.push(...names(page) as string[]);
        if (page.length < 2) break;
        after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
      }
      assertEquals(paged, names(best));

      // `_` is a character, not LIKE's wildcard: no name starts with "seglats_".
      const wild = await ranked({ ref: 'name', dir: 'asc', match: 'seglats_' });
      assertEquals(wild.map((entry) => entry.sortValue), ['3', '3', '3', '3', '3', '3']);
    });

    await t.step('aggregate groups on the year a node was born', async () => {
      // birthtime is a node column, not an attr, so this is the only way to ask
      // "when did the archive gain this" — and imports preserve it, which is
      // what makes the answer a history rather than the date of the import.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'aged', { props: { mode: 0o755 } });
      const born = async (name: string, year: number, size: number) => {
        await vfs.create(ADMIN_ACCESS, 'file', '/aged', name, {
          props: { mode: 0o644, birthtime: { timestamp: new Date(`${year}-06-15T12:00:00`).getTime(), uid: 0 } },
          attrs: { mimetype: 'image/jpeg', size },
        });
      };

      await born('old-1.jpg', 2008, 100);
      await born('old-2.jpg', 2008, 250);
      await born('mid.jpg', 2015, 1000);
      // Not a number: counted, but contributes nothing to the sum.
      await vfs.create(ADMIN_ACCESS, 'file', '/aged', 'sizeless.jpg', {
        props: { mode: 0o644, birthtime: { timestamp: new Date('2015-02-02T00:00:00').getTime(), uid: 0 } },
        attrs: { mimetype: 'image/jpeg', size: 'not-a-number' },
      });

      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'mimetype', op: 'eq', value: 'image/jpeg' }, { ref: 'size', op: 'exists' }],
        group: [{ column: 'birthtime', truncate: 'year' }],
        sum: 'size',
      });

      const byYear = new Map(buckets.map((bucket) => [bucket.key[0], bucket]));
      assertEquals(byYear.get('2008'), { key: ['2008'], count: 2, sum: 350 });
      assertEquals(byYear.get('2015'), { key: ['2015'], count: 2, sum: 1000 });
    });

    await t.step('aggregate omits sum entirely when none was asked for', async () => {
      // Absent rather than zero, so a caller cannot mistake "not requested" for
      // "summed to nothing".
      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'mimetype', op: 'eq', value: 'image/jpeg' }],
        group: [{ column: 'birthtime', truncate: 'year' }],
      });

      assertEquals(buckets.every((bucket) => !('sum' in bucket)), true);
    });

    await t.step('birthUid narrows a query and an aggregate to one creator', async () => {
      // The creating uid is a node column, so this is the only way to ask
      // "what did this user add" without walking. Two creators, one size each,
      // so a wrong join or a dropped clause shows up in both the rows and the sum.
      const mine = async (name: string, uid: number, size: number) => {
        await vfs.create(ADMIN_ACCESS, 'file', '/aged', name, {
          props: { mode: 0o644, birthtime: { timestamp: new Date('2018-06-15T12:00:00').getTime(), uid } },
          attrs: { mimetype: 'image/jpeg', size, takenAt: `2018-06-${String(size).padStart(2, '0')}T12:00:00` },
        });
      };
      await mine('mine-1.jpg', 77, 1);
      await mine('mine-2.jpg', 77, 2);
      await mine('theirs.jpg', 78, 3);

      const rows = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        birthUid: 77,
        orderBy: { ref: 'takenAt', dir: 'desc' },
        limit: 50,
      });
      assertEquals(names(rows), ['mine-2.jpg', 'mine-1.jpg']);

      const buckets = await vfs.aggregate(ADMIN_ACCESS, {
        birthUid: 77,
        where: [{ ref: 'size', op: 'exists' }],
        group: [{ ref: 'takenAt', prefixLength: 4 }],
        sum: 'size',
      });
      assertEquals(buckets, [{ key: ['2018'], count: 2, sum: 3 }]);
    });

    await t.step('aggregate rejects a grouping it cannot bucket', async () => {
      // Ungrouped birthtime is one bucket per millisecond, and `type` is not a
      // timestamp. Both are caller mistakes worth failing on rather than
      // answering strangely.
      await assertRejects(() => vfs.aggregate(ADMIN_ACCESS, { types: ['file'], group: [{ column: 'birthtime' }] }));
      await assertRejects(() => vfs.aggregate(ADMIN_ACCESS, { types: ['file'], group: [{ column: 'type', truncate: 'year' }] }));
      await assertRejects(() => vfs.aggregate(ADMIN_ACCESS, { types: ['file'], group: [{ column: 'id', truncate: 'month' }] }));
    });

    await t.step('unreadable nodes are filtered out', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/media', 'secret.jpg', {
        props: { mode: 0o600, uid: 1234, gid: 1234 },
        attrs: { mimetype: 'image/jpeg', takenAt: '1997-01-01T00:00:00' },
      });

      const stranger: Access = { uid: 4321, gid: 4321, gids: [4321], admin: false };
      const entries = await vfs.query(stranger, {
        types: ['file'],
        where: [{ ref: 'mimetype', op: 'prefix', value: 'image/' }],
        limit: 50,
      });

      assertEquals(entries.some((e) => e.absPath.endsWith('secret.jpg')), false);
      // Admin still sees it, so the fixture itself is sound.
      const asAdmin = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: 'mimetype', op: 'prefix', value: 'image/' }],
        limit: 50,
      });
      assertEquals(asAdmin.some((e) => e.absPath.endsWith('secret.jpg')), true);
    });

    await runScopeSteps(t, vfs);
    await runPagingSteps(t, vfs);
  } finally {
    await dispose();
  }
}

/** Only this section's own nodes: every one carries `fixture`. */
const scoped = (fixture: string) => [{ ref: 'fixture', op: 'eq' as const, value: fixture }];

/**
 * `within` and `notWithin`, on queries and aggregates, with `counts`, `minCount` and `countWithin`.
 *
 *     /scope                  directory
 *       trip/                 album
 *         a.jpg               dated, hash H; its own metadata/exif and sidecar are not within
 *         link                softlink to /elsewhere/outside.jpg, which is not followed
 *       folder/
 *         deep/b.jpg          dated, hash H
 *         twin -> deep        the same directory linked twice: b.jpg is one row
 *         c.jpg               dated
 *         undated.jpg
 *         d1.jpg … d6.jpg     dated, for paging
 *       open/p.jpg            the file also at private/p.jpg
 *       private/              0700, another user's
 *     /elsewhere/outside.jpg  dated, hash H
 */
async function runScopeSteps(t: Deno.TestContext, vfs: NodeVFS) {
  const fixture = scoped('scope');
  const file = async (dir: string, name: string, attrs: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
    await vfs.create(ADMIN_ACCESS, 'file', dir, name, { props: { mode: 0o644, ...props }, attrs: { fixture: 'scope', mimetype: 'image/jpeg', ...attrs } });
  const dir = async (parent: string, name: string, type = 'directory', props: Record<string, unknown> = {}) =>
    await vfs.create(ADMIN_ACCESS, type, parent, name, { props: { mode: 0o755, ...props } });

  await dir('/', 'scope');
  await dir('/scope', 'trip', 'album');
  await file('/scope/trip', 'a.jpg', { takenAtUtc: '2001-01-01T10:00:00Z', sha256: 'h' });
  await dir('/scope/trip/a.jpg', 'metadata');
  await file('/scope/trip/a.jpg/metadata', 'exif', { takenAtUtc: '2001-01-01T10:00:00Z' });
  await file('/scope/trip/a.jpg', 'sidecar', { takenAtUtc: '2001-01-01T10:00:00Z', mimetype: 'application/json' });
  await dir('/', 'elsewhere');
  await file('/elsewhere', 'outside.jpg', { takenAtUtc: '2004-01-01T10:00:00Z', sha256: 'h' });
  await vfs.create(ADMIN_ACCESS, 'softlink', '/scope/trip', 'link', { props: { mode: 0o777, softlink: '/elsewhere/outside.jpg' } });
  await dir('/scope', 'folder');
  await dir('/scope/folder', 'deep');
  await file('/scope/folder/deep', 'b.jpg', { takenAtUtc: '2002-01-01T10:00:00Z', sha256: 'h' });
  await vfs.link(ADMIN_ACCESS, '/scope/folder/deep', '/scope/folder', 'twin');
  await file('/scope/folder', 'c.jpg', { takenAtUtc: '2003-01-01T10:00:00Z' });
  await file('/scope/folder', 'undated.jpg');
  for (let i = 1; i <= 6; i++) await file('/scope/folder', `d${i}.jpg`, { takenAtUtc: `2005-0${i}-01T10:00:00Z` });
  await dir('/scope', 'open');
  await file('/scope/open', 'p.jpg', { takenAtUtc: '2006-01-01T10:00:00Z' });
  await dir('/scope', 'private', 'directory', { mode: 0o700, uid: 1234, gid: 1234 });
  await vfs.link(ADMIN_ACCESS, '/scope/open/p.jpg', '/scope/private', 'p.jpg');

  const stranger: Access = { uid: 4321, gid: 4321, gids: [4321], admin: false };
  const scopeFiles = ['a.jpg', 'b.jpg', 'c.jpg', 'undated.jpg', 'd1.jpg', 'd2.jpg', 'd3.jpg', 'd4.jpg', 'd5.jpg', 'd6.jpg', 'p.jpg'];
  /** Each row once, by name: a node reached by two paths is one row. */
  const rowNames = (entries: { id: string; absPath: string }[]) => [...new Map(entries.map((e) => [e.id, e.absPath.split('/').pop()!])).values()].sort();

  await t.step("within lists the nested members, not a file's own children or what a link points at", async () => {
    const files = await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope', where: fixture, limit: 100 });
    assertEquals(rowNames(files), scopeFiles.toSorted());
    const links = await vfs.query(ADMIN_ACCESS, { types: ['softlink'], within: '/scope', limit: 100 });
    assertEquals(links.map((e) => e.absPath), ['/scope/trip/link']);
    // Only within the file itself are its own children, at any depth below it.
    assertEquals(rowNames(await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope/trip/a.jpg', limit: 100 })), ['exif', 'sidecar']);
  });

  await t.step('within, ordered by time, pages three keyset pages without a gap or a repeat', async () => {
    const order = { ref: 'takenAtUtc', dir: 'asc' as const };
    const all = await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope/folder', where: fixture, orderBy: order, limit: 100 });
    assertEquals(all.map((e) => e.absPath.split('/').pop()).filter((name) => name !== 'b.jpg'), ['c.jpg', 'd1.jpg', 'd2.jpg', 'd3.jpg', 'd4.jpg', 'd5.jpg', 'd6.jpg']);

    const paged: string[] = [];
    const sizes: number[] = [];
    let after: { value: string | null; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page: NodeQueryEntry[] = await vfs.query(ADMIN_ACCESS, {
        types: ['file'],
        within: '/scope/folder',
        where: [...fixture, { ref: 'takenAtUtc', op: 'gte', value: '2003' }],
        orderBy: order,
        after,
        limit: 3,
      });
      sizes.push(page.length);
      paged.push(...page.map((e) => e.absPath.split('/').pop()!));
      if (page.length < 3) break;
      after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
    }
    assertEquals(paged, ['c.jpg', 'd1.jpg', 'd2.jpg', 'd3.jpg', 'd4.jpg', 'd5.jpg', 'd6.jpg']);
    assertEquals(sizes, [3, 3, 1]);
  });

  await t.step('within, unordered, pages in id order', async () => {
    const paged: string[] = [];
    let after: { value: string | null; id: string } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page: NodeQueryEntry[] = await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope/folder', where: fixture, after, limit: 2 });
      paged.push(...page.map((e) => e.id));
      if (page.length < 2) break;
      after = { value: null, id: page[page.length - 1].id };
    }
    assertEquals(paged, paged.toSorted());
    assertEquals(new Set(paged).size, 9);
  });

  await t.step("notWithin leaves out each root's members, and a missing root is ignored", async () => {
    // a.jpg's own exif and sidecar are not within `trip`, so they stay.
    const left = await vfs.query(ADMIN_ACCESS, { types: ['file'], where: fixture, notWithin: ['/scope/folder', '/scope/trip', '/nowhere'], limit: 100 });
    assertEquals(rowNames(left), ['exif', 'outside.jpg', 'p.jpg', 'sidecar']);
    const both = await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope', where: fixture, notWithin: ['/scope/folder'], limit: 100 });
    assertEquals(rowNames(both), ['a.jpg', 'p.jpg']);
    // A within root inside a left-out one leaves nothing.
    assertEquals(await vfs.query(ADMIN_ACCESS, { types: ['file'], within: '/scope/folder', where: fixture, notWithin: ['/scope'], limit: 100 }), []);
    assertEquals(await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], within: '/scope/folder', where: fixture, notWithin: ['/scope'], group: [{ column: 'type' }] }), []);
  });

  await t.step('a within root the caller cannot enter is refused', async () => {
    await assertRejects(() => vfs.query(stranger, { types: ['file'], within: '/scope/private', limit: 10 }));
    await assertRejects(() => vfs.aggregate(stranger, { within: '/scope/private', group: [{ column: 'type' }] }));
    await assertRejects(() => vfs.countWithin(stranger, '/scope/private', 10));
  });

  await t.step("notWithin naming another user's private directory still removes its rows", async () => {
    // The stranger reaches p.jpg through `open`, and cannot enter `private`.
    const seen = await vfs.query(stranger, { types: ['file'], within: '/scope', where: fixture, limit: 100 });
    assertEquals(rowNames(seen).includes('p.jpg'), true);
    const without = await vfs.query(stranger, { types: ['file'], within: '/scope', where: fixture, notWithin: ['/scope/private'], limit: 100 });
    assertEquals(rowNames(without).includes('p.jpg'), false);
  });

  await t.step('aggregates take within, notWithin, named counts and a minimum count', async () => {
    const byHash = await vfs.aggregate(ADMIN_ACCESS, {
      types: ['file'],
      where: fixture,
      within: '/scope',
      group: [{ ref: 'sha256' }],
      counts: { dated: [{ ref: 'takenAtUtc', op: 'exists' }], early: [{ ref: 'takenAtUtc', op: 'lt', value: '2002' }] },
    });
    assertEquals(byHash, [{ key: ['h'], count: 2, counts: { dated: 2, early: 1 } }]);

    const everywhere = await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], where: fixture, group: [{ ref: 'sha256' }], minCount: 3 });
    assertEquals(everywhere, [{ key: ['h'], count: 3 }]);
    assertEquals(await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], where: fixture, within: '/scope', group: [{ ref: 'sha256' }], minCount: 3 }), []);

    const outside = await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], where: fixture, notWithin: ['/scope'], group: [{ ref: 'sha256' }] });
    assertEquals(outside, [{ key: ['h'], count: 1 }]);

    // A count that met nothing is there, at zero.
    const none = await vfs.aggregate(ADMIN_ACCESS, {
      types: ['file'],
      where: fixture,
      within: '/scope/folder',
      group: [{ column: 'type' }],
      counts: { audio: [{ ref: 'mimetype', op: 'prefix', value: 'audio/' }] },
    });
    assertEquals(none, [{ key: ['file'], count: 9, counts: { audio: 0 } }]);
  });

  await t.step('an aggregate refuses a count name that is not an identifier', async () => {
    await assertRejects(() => vfs.aggregate(ADMIN_ACCESS, { group: [{ column: 'type' }], counts: { "x') OR true --": [] } }));
    await assertRejects(() => vfs.aggregate(ADMIN_ACCESS, { group: [{ column: 'type' }], minCount: 0 }));
  });

  await t.step('countWithin counts the members, up to its cap', async () => {
    // trip, a.jpg, link, folder, deep (also twin), b.jpg, c.jpg, undated, d1…d6, open, p.jpg and
    // private are 17 nodes; a store counting edges counts twin, and b.jpg and p.jpg once more.
    const counted = await vfs.countWithin(ADMIN_ACCESS, '/scope', 1000);
    assertEquals(counted >= 17 && counted <= 20, true, String(counted));
    assertEquals(await vfs.countWithin(ADMIN_ACCESS, '/scope', 5), 5);
    assertEquals(await vfs.countWithin(ADMIN_ACCESS, '/scope/folder/deep', 1000), 1);
  });
}

/** The query loop's contract, and paged and typed children. */
async function runPagingSteps(t: Deno.TestContext, vfs: NodeVFS) {
  const stranger: Access = { uid: 4321, gid: 4321, gids: [4321], admin: false };
  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'loop', { props: { mode: 0o755 } });
  // Nine the stranger may not read come first in the order, then three it may.
  for (let i = 0; i < 12; i++) {
    const readable = i >= 9;
    await vfs.create(ADMIN_ACCESS, 'file', '/loop', `f${i}`, {
      props: readable ? { mode: 0o644 } : { mode: 0o600, uid: 1234, gid: 1234 },
      attrs: { fixture: 'loop', seq: String(i).padStart(2, '0') },
    });
  }

  await t.step('a run of three pages of unreadable rows still yields a full page', async () => {
    const page = await vfs.query(stranger, { types: ['file'], where: scoped('loop'), orderBy: { ref: 'seq', dir: 'asc' }, limit: 3 });
    assertEquals(page.map((e) => e.absPath), ['/loop/f9', '/loop/f10', '/loop/f11']);
  });

  await t.step('fewer rows than the limit means there are no more', async () => {
    const page = await vfs.query(stranger, { types: ['file'], where: scoped('loop'), orderBy: { ref: 'seq', dir: 'asc' }, limit: 4 });
    assertEquals(page.length, 3);
    const last = page[page.length - 1];
    assertEquals(
      await vfs.query(stranger, { types: ['file'], where: scoped('loop'), orderBy: { ref: 'seq', dir: 'asc' }, after: { value: last.sortValue, id: last.id }, limit: 4 }),
      [],
    );
  });

  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'collate', { props: { mode: 0o755 } });
  for (const [i, label] of ['Zeta', 'anna', 'Åsa', 'Ärla', 'Örn', 'Bo', 'Anna'].entries()) {
    await vfs.create(ADMIN_ACCESS, 'file', '/collate', `c${i}`, { props: { mode: 0o644 }, attrs: { fixture: 'collate', label } });
  }
  const labelled = (orderBy: NodeQueryOrder, after?: NodeQueryCursor, limit = 50) =>
    vfs.query(ADMIN_ACCESS, { types: ['file'], where: scoped('collate'), orderBy, after, limit });

  await t.step('an order compares bytes unless it asks for a language', async () => {
    const bytes = await labelled({ ref: 'label', dir: 'asc' });
    assertEquals(bytes.map((e) => e.sortValue), ['Anna', 'Bo', 'Zeta', 'anna', 'Ärla', 'Åsa', 'Örn']);
    const swedish = await labelled({ ref: 'label', dir: 'asc', collation: 'sv' });
    assertEquals(swedish.map((e) => e.sortValue), ['anna', 'Anna', 'Bo', 'Zeta', 'Åsa', 'Ärla', 'Örn']);
    const english = await labelled({ ref: 'label', dir: 'asc', collation: 'en' });
    assertEquals(english.map((e) => e.sortValue), ['anna', 'Anna', 'Ärla', 'Åsa', 'Bo', 'Örn', 'Zeta']);
  });

  await t.step('a cursor resumes in a language, either way', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const order: NodeQueryOrder = { ref: 'label', dir, collation: 'sv' };
      const whole = await labelled(order);
      const paged: NodeQueryEntry[] = [];
      let after: NodeQueryCursor | undefined;
      for (;;) {
        const page = await labelled(order, after, 2);
        paged.push(...page);
        if (page.length < 2) break;
        after = { value: page[1].sortValue, id: page[1].id };
      }
      assertEquals(paged.map((e) => e.id), whole.map((e) => e.id));
    }
  });

  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'kids', { props: { mode: 0o755 } });
  for (const [name, type] of [['e', 'file'], ['b', 'directory'], ['d', 'file'], ['a', 'file'], ['c', 'directory']]) {
    await vfs.create(ADMIN_ACCESS, type, '/kids', name, { props: { mode: 0o755 } });
  }

  await t.step('children page in name order from a name', async () => {
    const names = async (after?: string) => (await vfs.children(ADMIN_ACCESS, '/kids', { page: { limit: 2, after } })).map((entry) => entry.name);
    assertEquals(await names(), ['a', 'b']);
    assertEquals(await names('b'), ['c', 'd']);
    assertEquals(await names('d'), ['e']);
    assertEquals(await names('e'), []);
  });

  await t.step('children of some types only, paged or whole', async () => {
    assertEquals((await vfs.children(ADMIN_ACCESS, '/kids', { types: ['directory'] })).map((entry) => entry.name).sort(), ['b', 'c']);
    assertEquals((await vfs.children(ADMIN_ACCESS, '/kids', { types: ['file'], page: { limit: 2, after: 'a' } })).map((entry) => entry.name), ['d', 'e']);
  });

  await t.step('a page of children cannot be filtered by name', async () => {
    await assertRejects(() => vfs.children(ADMIN_ACCESS, '/kids', { page: { limit: 2 }, filter: { name: 'a*' } }));
  });

  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'by-name', { props: { mode: 0o755 } });
  const group = [{ ref: 'group', op: 'eq' as const, value: 'named' }];
  for (const [entry, type, name] of [['f1', 'file', 'Bertil'], ['d1', 'directory', 'Cecilia'], ['f2', 'file', 'Anna'], ['d2', 'directory', 'Anna']]) {
    await vfs.create(ADMIN_ACCESS, type, '/by-name', entry, { props: { mode: 0o755 }, attrs: { group: 'named', name } });
  }
  await vfs.create(ADMIN_ACCESS, 'directory', '/by-name', 'd3', { props: { mode: 0o755 }, attrs: { group: 'named' } });
  await vfs.create(ADMIN_ACCESS, 'directory', '/by-name', 'd4', { props: { mode: 0o755 }, attrs: { group: 'named', name: 'Bertil' } });

  await t.step('one type in name order pages without the other types, and takes a name given later', async () => {
    await vfs.update(ADMIN_ACCESS, '/by-name/d3', { attrs: { name: 'Adam' } });
    const order = { ref: 'name', dir: 'asc' as const, collation: 'sv' as const };
    const paged: string[] = [];
    let after: { value: string | null; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await vfs.query(ADMIN_ACCESS, { types: ['directory'], where: group, orderBy: order, after, limit: 2 });
      paged.push(...names(page) as string[]);
      if (page.length < 2) break;
      after = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };
    }
    assertEquals(paged, ['d3', 'd2', 'd4', 'd1']);
    const files = await vfs.query(ADMIN_ACCESS, { types: ['file'], where: group, orderBy: { ...order, dir: 'desc' }, limit: 10 });
    assertEquals(names(files), ['f1', 'f2']);
  });
}
