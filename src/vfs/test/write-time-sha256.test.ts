/**
 * Write-time sha256: a writable file handle persists `attrs.sha256` in the same
 * write that persists `attrs.size`, hashed from the bytes as they go past.
 *
 * The hash is a property of the content exactly as the length is, so the two
 * belong to the same moment.
 */

import { assertEquals, assertNotEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createHash } from 'node:crypto';
import { ResourceSeekMode } from '../../registries/types.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const enc = new TextEncoder();

const mkfile = async (vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'], name: string) =>
  await vfs.create(ADMIN_ACCESS, 'file', '/', name, {
    attrs: { name, mimetype: 'application/octet-stream', size: 0 },
  });

Deno.test('write-time sha256', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  await t.step('a truncating write records the digest of what it wrote', async () => {
    await mkfile(vfs, 'a.bin');
    const body = enc.encode('hello world');

    const h = await vfs.open(ADMIN_ACCESS, '/a.bin', { mode: 'w' });
    await h.write(body);
    await h.close();

    const node = await vfs.get(ADMIN_ACCESS, '/a.bin');
    assertEquals(node.attrs.size, body.length);
    assertEquals(node.attrs.sha256, sha256Hex(body));
  });

  await t.step('chunked writes hash to the same digest as one write', async () => {
    await mkfile(vfs, 'b.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/b.bin', { mode: 'w' });
    for (const part of ['hello', ' ', 'world']) await h.write(enc.encode(part));
    await h.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/b.bin')).attrs.sha256, sha256Hex(enc.encode('hello world')));
  });

  await t.step('the writable stream hashes too — most callers pipe rather than write()', async () => {
    await mkfile(vfs, 'c.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/c.bin', { mode: 'w' });
    const writer = h.writable.getWriter();
    await writer.write(enc.encode('piped bytes'));
    await writer.close();
    await h.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/c.bin')).attrs.sha256, sha256Hex(enc.encode('piped bytes')));
  });

  await t.step('a sync mid-write does not finalise the hasher', async () => {
    // close() reports after sync() already did. Finalising on the first would
    // leave the second with a dead hasher, so the digest is taken from a copy.
    await mkfile(vfs, 'd.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/d.bin', { mode: 'w' });
    await h.write(enc.encode('first'));
    await h.sync();
    assertEquals((await vfs.get(ADMIN_ACCESS, '/d.bin')).attrs.sha256, sha256Hex(enc.encode('first')));

    await h.write(enc.encode('-second'));
    await h.close();
    assertEquals((await vfs.get(ADMIN_ACCESS, '/d.bin')).attrs.sha256, sha256Hex(enc.encode('first-second')));
  });

  await t.step('rewriting a file replaces the digest rather than keeping the old one', async () => {
    await mkfile(vfs, 'e.bin');
    const first = await vfs.open(ADMIN_ACCESS, '/e.bin', { mode: 'w' });
    await first.write(enc.encode('one'));
    await first.close();
    const before = (await vfs.get(ADMIN_ACCESS, '/e.bin')).attrs.sha256;

    const second = await vfs.open(ADMIN_ACCESS, '/e.bin', { mode: 'w' });
    await second.write(enc.encode('two'));
    await second.close();
    const after = (await vfs.get(ADMIN_ACCESS, '/e.bin')).attrs.sha256;

    assertNotEquals(before, after);
    assertEquals(after, sha256Hex(enc.encode('two')));
  });

  await t.step('offset-addressed sequential writes hash as they go — the SFTP upload path', async () => {
    // SFTP addresses every write packet by offset, so its handler seeks before
    // each one. Those seeks land exactly where the digest already ends, so they
    // are not movement: treating them as such would make every upload blind on
    // its first packet and pay a full re-read at close.
    await mkfile(vfs, 'sftp.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/sftp.bin', { mode: 'w' });

    const parts = ['packet-one', 'packet-two', 'packet-three'];
    let offset = 0;
    for (const part of parts) {
      await h.seek(offset, ResourceSeekMode.Start);
      const bytes = enc.encode(part);
      await h.write(bytes);
      offset += bytes.length;
    }
    await h.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/sftp.bin')).attrs.sha256, sha256Hex(enc.encode(parts.join(''))));
  });

  await t.step('a read-write open of an empty file hashes as it goes — an SFTP create with EXCL', async () => {
    // An empty file holds exactly the bytes written to it from offset 0, so no
    // read-back is owed. A blind handle reports null at sync; this one keeps
    // its digest through it.
    await mkfile(vfs, 'excl.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/excl.bin', { mode: 'r+' });
    await h.write(enc.encode('first'));
    await h.sync();
    assertEquals((await vfs.get(ADMIN_ACCESS, '/excl.bin')).attrs.sha256, sha256Hex(enc.encode('first')));
    await h.seek(5, ResourceSeekMode.Start);
    await h.write(enc.encode('-second'));
    await h.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/excl.bin')).attrs.sha256, sha256Hex(enc.encode('first-second')));
  });

  await t.step('a seek backwards is real movement and gives up the running digest', async () => {
    await mkfile(vfs, 'back.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/back.bin', { mode: 'w' });
    await h.write(enc.encode('abcdef'));
    await h.seek(2, ResourceSeekMode.Start);
    await h.write(enc.encode('ZZ'));
    await h.close();

    // Read back rather than streamed, but still the digest of what is on disk.
    assertEquals((await vfs.get(ADMIN_ACCESS, '/back.bin')).attrs.sha256, sha256Hex(enc.encode('abZZef')));
  });

  await t.step('an append ends with the digest of the whole file, not of the appended part', async () => {
    // Only the appended bytes go past the handle, so the streaming digest would
    // be the digest of a file that does not exist. Close reads the finished
    // bytes back instead — the file still ends up hashed.
    await mkfile(vfs, 'f.bin');
    const w = await vfs.open(ADMIN_ACCESS, '/f.bin', { mode: 'w' });
    await w.write(enc.encode('base'));
    await w.close();
    assertEquals((await vfs.get(ADMIN_ACCESS, '/f.bin')).attrs.sha256, sha256Hex(enc.encode('base')));

    const a = await vfs.open(ADMIN_ACCESS, '/f.bin', { mode: 'a' });
    await a.write(enc.encode('-more'));
    await a.close();

    const node = await vfs.get(ADMIN_ACCESS, '/f.bin');
    assertEquals(node.attrs.size, 9);
    assertEquals(node.attrs.sha256, sha256Hex(enc.encode('base-more')));
    assertNotEquals(node.attrs.sha256, sha256Hex(enc.encode('-more')), 'not the digest of just the appended bytes');
  });

  await t.step('a seek during a write ends with the digest of what is on disk', async () => {
    await mkfile(vfs, 'g.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/g.bin', { mode: 'w' });
    await h.write(enc.encode('abcdef'));
    await h.seek(0, ResourceSeekMode.Start);
    await h.write(enc.encode('Z'));
    await h.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/g.bin')).attrs.sha256, sha256Hex(enc.encode('Zbcdef')));
  });

  await t.step('an append that syncs before closing still gets its read-back', async () => {
    // The sync clears the attr and resets the dirty flag, so "nothing changed
    // since the last flush" is true at close — but the attr is null and only the
    // read-back can put a value back. Decided on whether the handle ever wrote,
    // not on whether it wrote since the last report.
    await mkfile(vfs, 'j.bin');
    const w = await vfs.open(ADMIN_ACCESS, '/j.bin', { mode: 'w' });
    await w.write(enc.encode('start'));
    await w.close();

    const a = await vfs.open(ADMIN_ACCESS, '/j.bin', { mode: 'a' });
    await a.write(enc.encode('-end'));
    await a.sync();
    assertEquals((await vfs.get(ADMIN_ACCESS, '/j.bin')).attrs.sha256 ?? null, null, 'cleared mid-write');
    await a.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/j.bin')).attrs.sha256, sha256Hex(enc.encode('start-end')));
  });

  await t.step('a read-write open that writes nothing leaves the hash alone', async () => {
    // Nothing was written, so there is nothing to re-hash and no reason to pay
    // for a read-back.
    await mkfile(vfs, 'i.bin');
    const w = await vfs.open(ADMIN_ACCESS, '/i.bin', { mode: 'w' });
    await w.write(enc.encode('untouched'));
    await w.close();
    const before = (await vfs.get(ADMIN_ACCESS, '/i.bin')).attrs.sha256;

    const rw = await vfs.open(ADMIN_ACCESS, '/i.bin', { mode: 'r+' });
    await rw.close();

    assertEquals((await vfs.get(ADMIN_ACCESS, '/i.bin')).attrs.sha256, before);
  });

  await t.step('an empty truncating write records the digest of nothing', async () => {
    await mkfile(vfs, 'h.bin');
    const h = await vfs.open(ADMIN_ACCESS, '/h.bin', { mode: 'w' });
    await h.close();

    const node = await vfs.get(ADMIN_ACCESS, '/h.bin');
    assertEquals(node.attrs.size, 0);
    assertEquals(node.attrs.sha256, sha256Hex(new Uint8Array(0)));
  });

  await ctx.dispose?.();
});
