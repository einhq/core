/**
 * `tar` lists and expands an archive, gzip-compressed or not, read from a file or from stdin: files
 * with their bytes, size, sha256 and time, directories, softlinks and hard links; GNU
 * long names and pax paths; only the names given, with leading names stripped; an archive ending in
 * a lone zero block or none. A run again leaves the files there; one of another size fails unless
 * `--overwrite`. An entry that would land outside the directory refuses an archive in a file before
 * anything is written, and fails alone in one read from stdin; so does too little free space.
 * `-xO` writes a file's bytes to stdout. The archives are built here, byte by byte.
 */

import { assertEquals, assertMatch, assertRejects } from '@std/assert';
import { gzipSync } from 'node:zlib';
import type { TarAnswer, TarListEntry } from '../../../../lib/api/node.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { ExpandRefusedError } from '../node/expand.ts';
import { expandTar } from '../node/tar.ts';

const testCtx = createTestContext();
const encoder = new TextEncoder();

/** One entry of a test archive. */
type Spec = {
  path: string;
  type?: string;
  body?: string | Uint8Array;
  mode?: number;
  linkname?: string;
  /** Written as a GNU long name entry (`L`) before the header. */
  gnuLong?: boolean;
  /** Written as a pax header (`x`) with the path before the header. */
  pax?: boolean;
};

const MTIME = Date.UTC(2019, 6, 14, 10, 30) / 1000;

const header = (name: string, type: string, size: number, mode: number, linkname = ''): Uint8Array => {
  const block = new Uint8Array(512);
  const put = (text: string, at: number, length: number) => block.set(encoder.encode(text).subarray(0, length), at);
  const octal = (value: number, at: number, length: number) => put(value.toString(8).padStart(length - 1, '0'), at, length - 1);
  put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(MTIME, 136, 12);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put('ustar\u000000', 257, 8);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, '0') + '\u0000 ', 148, 8);
  return block;
};

const padded = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
};

/** A tar archive of `specs`, ending in `endBlocks` zero blocks. */
const tarOf = (specs: Spec[], endBlocks = 2): Uint8Array<ArrayBuffer> => {
  const parts: Uint8Array[] = [];
  for (const spec of specs) {
    const type = spec.type ?? '0';
    const body = typeof spec.body === 'string' ? encoder.encode(spec.body) : spec.body ?? new Uint8Array();
    let name = spec.path;
    if (spec.gnuLong) {
      const long = encoder.encode(`${spec.path}\0`);
      parts.push(header('././@LongLink', 'L', long.length, 0o644), padded(long));
      name = spec.path.slice(0, 99);
    }
    if (spec.pax) {
      const record = ` path=${spec.path}\n`;
      let length = record.length + 1;
      while (String(length).length + record.length !== length) length++;
      const pax = encoder.encode(`${length}${record}`);
      parts.push(header('PaxHeader', 'x', pax.length, 0o644), padded(pax));
      name = 'short-name';
    }
    parts.push(header(name, type, body.length, spec.mode ?? (type === '5' ? 0o755 : 0o644), spec.linkname), padded(body));
  }
  for (let i = 0; i < endBlocks; i++) parts.push(new Uint8Array(512));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** `bytes` gzip-compressed. */
const gz = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));

const BINARY = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);

const ARCHIVE: Spec[] = [
  { path: 'Exempelspel/', type: '5' },
  { path: 'Exempelspel/data/', type: '5' },
  { path: 'Exempelspel/data/nivå-1.pak', body: BINARY },
  { path: 'Exempelspel/läsmig.txt', body: 'Ett spel om en segelbåt.\n' },
  { path: 'Exempelspel/starta.sh', body: '#!/bin/sh\necho start\n', mode: 0o755 },
  { path: 'Exempelspel/senaste', type: '2', linkname: 'data/nivå-1.pak' },
  { path: 'Exempelspel/kopia.txt', type: '1', linkname: 'Exempelspel/läsmig.txt' },
  { path: `Exempelspel/${'långt-namn-'.repeat(12)}.txt`, body: 'gnu\n', gnuLong: true },
  { path: `Exempelspel/${'pax-namn-'.repeat(14)}.txt`, body: 'pax\n', pax: true },
];

Deno.test({
  name: 'tar',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const put = async (path: string, bytes: Uint8Array) => {
    await cmd.shouldSucceed(`mkfile '${path}'`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  };
  const bytesOf = async (path: string): Promise<Uint8Array> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return new Uint8Array(await new Response(handle.readable).arrayBuffer());
    } finally {
      await handle.close().catch(() => {});
    }
  };
  const text = async (path: string) => new TextDecoder().decode(await bytesOf(path));

  try {
    await cmd.shouldSucceed('mkdir -p /t');
    const plain = tarOf(ARCHIVE);
    await put('/t/spel.tar', plain);
    await put('/t/spel.tar.gz', gz(plain));

    await t.step('-xzf expands files, directories and links, long names included', async () => {
      const answer = await client.execJson<TarAnswer>('tar -xzf /t/spel.tar.gz -C /t/ut');

      assertEquals(answer, {
        ok: true,
        archive: '/t/spel.tar.gz',
        directory: '/t/ut',
        files: 5,
        // ut, Exempelspel and data
        directories: 3,
        links: 2,
        bytes: BINARY.length + encoder.encode('Ett spel om en segelbåt.\n#!/bin/sh\necho start\n').length + 4 + 4,
        skipped: 0,
        failed: [],
      });
      assertEquals(await bytesOf('/t/ut/Exempelspel/data/nivå-1.pak'), BINARY);
      assertEquals(await text('/t/ut/Exempelspel/läsmig.txt'), 'Ett spel om en segelbåt.\n');
      assertEquals(await text(`/t/ut/Exempelspel/${'långt-namn-'.repeat(12)}.txt`), 'gnu\n');
      assertEquals(await text(`/t/ut/Exempelspel/${'pax-namn-'.repeat(14)}.txt`), 'pax\n');
      assertEquals(await text('/t/ut/Exempelspel/kopia.txt'), 'Ett spel om en segelbåt.\n');

      const pak = await vfs.get(ADMIN_ACCESS, '/t/ut/Exempelspel/data/nivå-1.pak');
      assertEquals(pak.attrs.size, BINARY.length);
      assertMatch(String(pak.attrs.sha256), /^[0-9a-f]{64}$/);
      assertEquals(pak.attrs.writtenAt, '2019-07-14T10:30:00.000Z');

      const link = await vfs.get(ADMIN_ACCESS, '/t/ut/Exempelspel/senaste', { readlink: true });
      assertEquals(link.props.softlink, 'data/nivå-1.pak');
      assertEquals(await bytesOf('/t/ut/Exempelspel/senaste'), BINARY);
    });

    await t.step('-t lists the entries; -v with mode, size and time; JSON as TarListEntry', async () => {
      const names = (await client.execString('tar -tf /t/spel.tar', { json: false })).trim().split('\n');
      assertEquals(names, ARCHIVE.map((spec) => spec.path));

      const long = (await client.execString('tar -tvzf /t/spel.tar.gz Exempelspel/starta.sh', { json: false })).trim();
      assertEquals(long, '-rwxr-xr-x         21 2019-07-14 10:30 Exempelspel/starta.sh');

      const listed = await client.execJson<TarListEntry[]>('tar -tf /t/spel.tar.gz Exempelspel/senaste');
      assertEquals(listed, [{ path: 'Exempelspel/senaste', type: 'symlink', size: 0, mode: 0o644, mtime: '2019-07-14T10:30:00.000Z', linkname: 'data/nivå-1.pak' }]);
    });

    await t.step('old-style options, names given and --strip-components', async () => {
      const answer = await client.execJson<TarAnswer>(
        'cd /t && tar xf spel.tar -C valda --strip-components 1 Exempelspel/data ./Exempelspel/läsmig.txt',
      );
      assertEquals({ files: answer.files, links: answer.links, ok: answer.ok }, { files: 2, links: 0, ok: true });
      assertEquals(await bytesOf('/t/valda/data/nivå-1.pak'), BINARY);
      assertEquals(await text('/t/valda/läsmig.txt'), 'Ett spel om en segelbåt.\n');
      assertEquals(await client.execJson<unknown[]>('ls /t/valda').then((rows) => rows.length), 2);

      const missing = await cmd.shouldFail('tar -xf /t/spel.tar -C /t/valda Exempelspel/saknas.txt');
      assertMatch(String(missing.error), /Exempelspel\/saknas\.txt: not found in the archive/);
    });

    await t.step('a run again leaves the files; another size fails; --overwrite writes over it', async () => {
      const again = await client.execJson<TarAnswer>('tar -xf /t/spel.tar -C /t/ut');
      assertEquals({ files: again.files, skipped: again.skipped, links: again.links, ok: again.ok }, { files: 0, skipped: 7, links: 0, ok: true });

      await cmd.shouldSucceed('echo "someone else wrote this here" > /t/ut/Exempelspel/läsmig.txt');
      const failed = await cmd.shouldFail('tar -xf /t/spel.tar -C /t/ut');
      assertMatch(String(failed.error), /läsmig\.txt: a file of another size is there .*--overwrite writes over it/);
      assertEquals(await text('/t/ut/Exempelspel/läsmig.txt'), 'someone else wrote this here\n');

      const answer = await client.execJson<TarAnswer>('tar -xf /t/spel.tar -C /t/ut --overwrite');
      assertEquals(answer.ok, true);
      assertEquals(await text('/t/ut/Exempelspel/läsmig.txt'), 'Ett spel om en segelbåt.\n');
    });

    await t.step('an entry outside the directory refuses an archive in a file before anything is written', async () => {
      await put('/t/slip.tar', tarOf([{ path: 'först.txt', body: 'a' }, { path: '../ute.txt', body: 'b' }]));
      const result = await cmd.shouldFail('tar -xf /t/slip.tar -C /t/slip');
      assertMatch(String(result.error), /refusing entry '\.\.\/ute\.txt': it would land outside \/t\/slip/);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/t/slip'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/t/ute.txt'), false);

      const absolute = await cmd.shouldFail('cat /t/slip.tar | tar -x -C /t/slip');
      assertMatch(String(absolute.error), /\.\.\/ute\.txt: it would land outside \/t\/slip/);
      assertEquals(await text('/t/slip/först.txt'), 'a');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/t/ute.txt'), false);
    });

    await t.step('a shell header cut off with tail -c is piped into tar, which ends at a lone zero block', async () => {
      const shellHeader = encoder.encode('#!/bin/sh\n# an installer\nexit 0\n');
      const archive = gz(tarOf([{ path: 'spel/data/nivå-1.pak', body: BINARY }, { path: 'spel/EULA.txt', body: 'Villkor.\n' }], 1));
      const installer = new Uint8Array(shellHeader.length + archive.length);
      installer.set(shellHeader);
      installer.set(archive, shellHeader.length);
      await put('/t/installer.gz.sh', installer);

      const from = shellHeader.length + 1;
      await cmd.shouldSucceed(`tail -c +${from} /t/installer.gz.sh > /t/installer.tar.gz`);
      assertEquals(await bytesOf('/t/installer.tar.gz'), archive);

      const answer = await client.execJson<TarAnswer>(`tail -c +${from} /t/installer.gz.sh | tar -xzf - -C /t/rör spel/data/nivå-1.pak`);
      assertEquals({ archive: answer.archive, files: answer.files, ok: answer.ok }, { archive: '-', files: 1, ok: true });
      assertEquals(await bytesOf('/t/rör/spel/data/nivå-1.pak'), BINARY);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/t/rör/spel/EULA.txt'), false);

      await put('/t/utan-slut.tar', tarOf([{ path: 'a.txt', body: 'utan slut' }], 0));
      assertEquals(await client.execString('tar -xOf /t/utan-slut.tar a.txt', { json: false }), 'utan slut');
    });

    await t.step('-xO writes a file to stdout as its bytes', async () => {
      await cmd.shouldSucceed('tar -xOzf /t/spel.tar.gz Exempelspel/data/nivå-1.pak > /t/ur-arkivet.pak');
      assertEquals(await bytesOf('/t/ur-arkivet.pak'), BINARY);
    });

    await t.step('-z on an archive that is not gzip, and bytes that are not tar, fail', async () => {
      assertMatch(String((await cmd.shouldFail('tar -xzf /t/spel.tar -C /t/x')).error), /not in gzip format/);
      await put('/t/text.txt', encoder.encode('just some text, not a tar archive at all\n'.repeat(20)));
      assertMatch(String((await cmd.shouldFail('tar -tf /t/text.txt')).error), /not a tar archive/);
    });

    await t.step('too little free space refuses the archive before anything is written', async () => {
      const source = { name: '/t/spel.tar', rereadable: true, open: async () => new Blob([plain]).stream() };
      await assertRejects(
        () => expandTar(vfs, ADMIN_ACCESS, source, '/t/trångt', { members: [], strip: 0, gzip: false, overwrite: false, freeBytes: () => Promise.resolve(1000) }),
        ExpandRefusedError,
        'not enough space',
      );
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/t/trångt'), false);

      const once = { name: '-', rereadable: false, open: async () => new Blob([plain]).stream() };
      const answer = await expandTar(vfs, ADMIN_ACCESS, once, '/t/trångt', {
        members: [],
        strip: 0,
        gzip: false,
        overwrite: false,
        freeBytes: () => Promise.resolve(1000),
      });
      assertEquals(answer.failed.map((failure) => failure.entry), ['Exempelspel/data/nivå-1.pak']);
      assertEquals(answer.files, 4);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
