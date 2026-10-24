/**
 * Write-time mimetype: a file created with an untyped mimetype (`text/plain`,
 * octet-stream, none) is sniffed again from the head of what a writable handle
 * writes, so a file whose name says nothing (`/etc/bashrc`, a module's `bin/`
 * commands) is still told apart as a shell script or a note.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';

const enc = new TextEncoder();

const mkfile = async (vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'], name: string, mimetype: string) =>
  await vfs.create(ADMIN_ACCESS, 'file', '/', name, { attrs: { name, mimetype, size: 0 } });

const mimeOf = async (vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'], path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs.mimetype;

Deno.test('write-time mimetype', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  await t.step('a truncating write re-types an untyped node from its shebang', async () => {
    await mkfile(vfs, 'bashrc', 'text/plain');
    const h = await vfs.open(ADMIN_ACCESS, '/bashrc', { mode: 'w' });
    await h.write(enc.encode('#!bash\n\nalias ll="ls -al"\n'));
    await h.close();

    assertEquals(await mimeOf(vfs, '/bashrc'), 'text/x-shellscript');
  });

  await t.step('an append onto an empty file is the head too — the `echo >> rc` path', async () => {
    await mkfile(vfs, 'rc', 'text/plain');
    const h = await vfs.open(ADMIN_ACCESS, '/rc', { mode: 'a' });
    await h.write(enc.encode('#!ts\nexport default 1;\n'));
    await h.close();

    assertEquals(await mimeOf(vfs, '/rc'), 'text/typescript');
  });

  await t.step('an append onto content leaves the mimetype alone', async () => {
    const h = await vfs.open(ADMIN_ACCESS, '/bashrc', { mode: 'a' });
    await h.write(enc.encode('export PATH="$PATH:/modules/x/bin"\n'));
    await h.close();

    assertEquals(await mimeOf(vfs, '/bashrc'), 'text/x-shellscript');
  });

  await t.step('a typed node is not second-guessed by the sniffer', async () => {
    await mkfile(vfs, 'a.cr2', 'image/x-canon-cr2');
    const h = await vfs.open(ADMIN_ACCESS, '/a.cr2', { mode: 'w' });
    await h.write(enc.encode('not really a raw file\n'));
    await h.close();

    assertEquals(await mimeOf(vfs, '/a.cr2'), 'image/x-canon-cr2');
  });

  await t.step('plain text stays text/plain; binary becomes octet-stream', async () => {
    await mkfile(vfs, 'note', 'text/plain');
    let h = await vfs.open(ADMIN_ACCESS, '/note', { mode: 'w' });
    await h.write(enc.encode('just a note\n'));
    await h.close();
    assertEquals(await mimeOf(vfs, '/note'), 'text/plain');

    await mkfile(vfs, 'description', 'text/plain');
    h = await vfs.open(ADMIN_ACCESS, '/description', { mode: 'w' });
    await h.write(enc.encode('Garden party at the lake house. A sunny day with the whole family.\n'));
    await h.close();
    assertEquals(await mimeOf(vfs, '/description'), 'text/plain');

    await mkfile(vfs, 'blob', 'text/plain');
    h = await vfs.open(ADMIN_ACCESS, '/blob', { mode: 'w' });
    await h.write(new Uint8Array([0x01, 0x00, 0xff, 0xfe, 0x00, 0x7f]));
    await h.close();
    assertEquals(await mimeOf(vfs, '/blob'), 'application/octet-stream');
  });

  await t.step('the writable stream carries the head as well', async () => {
    await mkfile(vfs, 'piped', 'application/octet-stream');
    const h = await vfs.open(ADMIN_ACCESS, '/piped', { mode: 'w' });
    const writer = h.writable.getWriter();
    await writer.write(enc.encode('#!/usr/bin/env python3\nprint(1)\n'));
    await writer.close();
    await h.close();

    assertEquals(await mimeOf(vfs, '/piped'), 'text/x-python');
  });

  await ctx.dispose?.();
});
