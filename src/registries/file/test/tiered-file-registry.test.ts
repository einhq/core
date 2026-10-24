import { assert, assertEquals } from '@std/assert';
import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { MemoryFileRegistry, TieredFileRegistry } from '../mod.ts';

// A tiered registry with a single backend must satisfy the base binary contract.
binaryConformanceTests('TieredFileRegistry (single backend) conformance', async () => {
  const registry = new TieredFileRegistry({ disk: new MemoryFileRegistry() });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
}, { times: true });

const enc = new TextEncoder();

Deno.test('TieredFileRegistry routes writes by tier attrs', async (t) => {
  const disk = new MemoryFileRegistry();
  const volatileReg = new MemoryFileRegistry();
  const db = new MemoryFileRegistry();
  const reg = new TieredFileRegistry({ disk, volatile: volatileReg, db });
  await reg.init();

  const write = async (id: string, opts: Record<string, unknown>, body: string) => {
    const handle = await reg.open(id, opts as never, 'w');
    await handle.write(enc.encode(body));
    await handle.close();
  };

  await t.step('original (no sourceId) → disk', async () => {
    await write('id-orig', { name: 'a.jpg', mimetype: 'image/jpeg', size: 0 }, 'ORIG');
    assert(await disk.exists('id-orig'));
    assert(!(await volatileReg.exists('id-orig')));
    assert(!(await db.exists('id-orig')));
  });

  await t.step('rendition (sourceId, not frozen) → volatile', async () => {
    await write('id-thumb', { sourceId: 'id-orig', mimetype: 'image/webp', size: 0 }, 'THUMB');
    assert(await volatileReg.exists('id-thumb'));
    assert(!(await disk.exists('id-thumb')));
  });

  await t.step('frozen RAW version (sourceId + frozen) → disk', async () => {
    await write('id-raw', { sourceId: 'id-orig', frozen: true, mimetype: 'image/x-raw', size: 0 }, 'RAW');
    assert(await disk.exists('id-raw'));
    assert(!(await volatileReg.exists('id-raw')));
  });

  await t.step('explicit tier=db → db', async () => {
    await write('id-note', { tier: 'db', mimetype: 'text/markdown', size: 0 }, 'NOTE');
    assert(await db.exists('id-note'));
    assert(!(await disk.exists('id-note')));
    assert(!(await volatileReg.exists('id-note')));
  });

  await t.step('stat/statX/delete route with attrs', async () => {
    assertEquals((await reg.stat('id-thumb', { sourceId: 'id-orig' } as never)).size, 5);
    assertEquals((await reg.statX('id-note', { tier: 'db' } as never)).size, 4);
    assert(await reg.delete('id-thumb', { sourceId: 'id-orig' } as never));
    assert(!(await volatileReg.exists('id-thumb')));
  });

  await t.step('exists / delete / list without attrs probe every backend', async () => {
    assert(await reg.exists('id-orig'));
    assert(await reg.delete('id-note')); // no attrs → removed from whichever backend (db)
    assert(!(await db.exists('id-note')));

    const names = new Set<string>();
    for await (const name of await reg.list()) {
      names.add(name);
    }
    assertEquals(names, new Set(['id-orig', 'id-raw']));
    assertEquals(await reg.count(), 2);
  });

  await reg.dispose();
});

Deno.test('TieredFileRegistry falls back to disk when volatile/db unset', async () => {
  const disk = new MemoryFileRegistry();
  const reg = new TieredFileRegistry({ disk });
  await reg.init();

  // Even a volatile-tier write lands on disk when no volatile backend is configured.
  const handle = await reg.open('id-x', { sourceId: 'p' } as never, 'w');
  await handle.write(enc.encode('X'));
  await handle.close();

  assert(await disk.exists('id-x'));
  assert(await reg.exists('id-x'));
  await reg.dispose();
});
