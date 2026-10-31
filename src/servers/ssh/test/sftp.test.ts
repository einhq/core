/**
 * SFTP Integration Tests
 *
 * Complements src/testing/system-test.test.ts (small roundtrip, stat, mkdir)
 * with large payloads, directory listing, unlink, softlinks and parallel
 * writes.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { assertEquals } from '@std/assert';
import { assertRejects } from '@std/assert';
import { encodeHex } from '@std/encoding';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { STATUS_CODE } from 'ssh2';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../../vfs/types/softlink.ts';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const fileType = (mode: number | undefined) => (mode ?? 0) & S_IFMT;

const harness = new SystemTestHarness();

Deno.test({
  name: 'SFTP operations',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.startPrimary();

  try {
    const { client, sftp } = await harness.connectSFTP();

    try {
      await t.step('uploads and downloads a large file (100KB)', async () => {
        const data = new Uint8Array(100 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

        // writeFile/readFile chunk internally past one SFTP packet (~31952 B)
        await sftp.writeFile('/home/admin/large.bin', data, { mode: 0o644 });

        const stats = await sftp.stat('/home/admin/large.bin');
        assertEquals(stats.size, data.length);

        const downloaded = await sftp.readFile('/home/admin/large.bin');
        assertEquals(downloaded, data);
      });

      await t.step('sets mimetype, sha256 and size on upload', async () => {
        // PNG magic + IHDR start so the content sniffer identifies it
        const data = new Uint8Array([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
          0x00,
          0x00,
          0x00,
          0x0d,
          0x49,
          0x48,
          0x44,
          0x52,
          0x00,
          0x00,
          0x00,
          0x01,
          0x00,
          0x00,
          0x00,
          0x01,
        ]);
        await sftp.writeFile('/home/admin/upload.png', data);

        const node = await harness.primary!.vfs.get(ADMIN_ACCESS, '/home/admin/upload.png');
        assertEquals(node.attrs.mimetype, 'image/png');
        assertEquals(node.attrs.size, data.length);
        assertEquals(node.attrs.sha256, encodeHex(sha256(data)));
      });

      await t.step('files an upload by its bytes, not its name', async () => {
        const data = new Uint8Array(70_000);
        data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
        for (let i = 16; i < data.length; i++) data[i] = (i * 13) & 0xff;
        await sftp.writeFile('/home/admin/misnamed.jpg', data);

        const node = await harness.primary!.vfs.get(ADMIN_ACCESS, '/home/admin/misnamed.jpg');
        assertEquals(node.attrs.mimetype, 'image/png');
        assertEquals(node.attrs.size, data.length);
        assertEquals(node.attrs.sha256, encodeHex(sha256(data)));
      });

      await t.step('freezes an upload of a type /etc/frozen-uploads lists and refuses to write over it', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.writeFile('/etc/frozen-uploads', await Deno.readFile(new URL('../../../builtin/core/etc/frozen-uploads', import.meta.url)));
        assertEquals((await vfs.get(ADMIN_ACCESS, '/etc/frozen-uploads')).attrs.frozen, undefined);

        try {
          const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
          await sftp.writeFile('/home/admin/frozen.png', png);
          assertEquals((await vfs.get(ADMIN_ACCESS, '/home/admin/frozen.png')).attrs.frozen, true);

          const err = await assertRejects(() => sftp.writeFile('/home/admin/frozen.png', new Uint8Array([1, 2, 3])));
          assertEquals((err as { code?: number }).code, STATUS_CODE.PERMISSION_DENIED);
          assertEquals((await vfs.get(ADMIN_ACCESS, '/home/admin/frozen.png')).attrs.size, png.length);

          // A RAF opens with an ASCII header, so only the name it is renamed to says it is a picture
          const raf = new Uint8Array(256);
          raf.set(new TextEncoder().encode('FUJIFILMCCD-RAW 0201FF116501X-Pr'));
          await sftp.writeFile('/home/admin/DSCF0001.RAF.filepart', raf);
          assertEquals((await vfs.get(ADMIN_ACCESS, '/home/admin/DSCF0001.RAF.filepart')).attrs.frozen, undefined);
          await sftp.rename('/home/admin/DSCF0001.RAF.filepart', '/home/admin/DSCF0001.RAF');

          const node = await vfs.get(ADMIN_ACCESS, '/home/admin/DSCF0001.RAF');
          assertEquals(node.attrs.mimetype, 'image/x-fujifilm-raf');
          assertEquals(node.attrs.frozen, true);
        } finally {
          await sftp.unlink('/etc/frozen-uploads');
        }
      });

      await t.step('types a file written under a temporary name by the name it is renamed to', async () => {
        const data = new TextEncoder().encode('{"title": "IMG_0001.jpg"}\n');
        await sftp.writeFile('/home/admin/IMG_0001.jpg.json.filepart', data);
        await sftp.rename('/home/admin/IMG_0001.jpg.json.filepart', '/home/admin/IMG_0001.jpg.json');

        const node = await harness.primary!.vfs.get(ADMIN_ACCESS, '/home/admin/IMG_0001.jpg.json');
        assertEquals(node.attrs.mimetype, 'application/json');
        assertEquals(node.attrs.size, data.length);
        await assertRejects(() => harness.primary!.vfs.get(ADMIN_ACCESS, '/home/admin/IMG_0001.jpg.json.filepart'));
      });

      await t.step('types a file created without content as an empty upload is', async () => {
        const handle = await sftp.open('/home/admin/created.md', 'w');
        await sftp.close(handle);
        await sftp.writeFile('/home/admin/empty.md', new Uint8Array());

        for (const path of ['/home/admin/created.md', '/home/admin/empty.md']) {
          const node = await harness.primary!.vfs.get(ADMIN_ACCESS, path);
          assertEquals(node.attrs.mimetype, 'application/octet-stream');
        }
      });

      await t.step('lists directory contents', async () => {
        await sftp.mkdir('/home/admin/listdir');
        const enc = new TextEncoder();
        await sftp.writeFile('/home/admin/listdir/file1.txt', enc.encode('content1'));
        await sftp.writeFile('/home/admin/listdir/file2.txt', enc.encode('content2'));

        // readdir(path) terminates cleanly on the server's end-of-listing EOF
        const entries = await sftp.readdir('/home/admin/listdir');
        const names = entries.map((e) => e.filename);

        assertEquals(names.includes('file1.txt'), true);
        assertEquals(names.includes('file2.txt'), true);
      });

      await t.step('unlinks a file', async () => {
        const enc = new TextEncoder();
        await sftp.writeFile('/home/admin/doomed.txt', enc.encode('bye'));
        await sftp.unlink('/home/admin/doomed.txt');

        await assertRejects(() => sftp.stat('/home/admin/doomed.txt'));
      });

      await t.step('handles parallel writes to separate files', async () => {
        const enc = new TextEncoder();
        const dec = new TextDecoder();

        await Promise.all(
          Array.from({ length: 5 }, (_, i) => sftp.writeFile(`/home/admin/chunk-${i}.txt`, enc.encode(`chunk${i}`))),
        );

        for (let i = 0; i < 5; i++) {
          const content = await sftp.readFile(`/home/admin/chunk-${i}.txt`);
          assertEquals(dec.decode(content), `chunk${i}`);
        }
      });

      await t.step('runs reads on separate handles concurrently', async () => {
        const paths = new Set([
          '/home/admin/parallel-read-1.bin',
          '/home/admin/parallel-read-2.bin',
        ]);
        const data = new Uint8Array(64 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff;

        await Promise.all([...paths].map((path) => sftp.writeFile(path, data)));

        const vfs = harness.primary!.vfs;
        const originalOpen = vfs.open;
        const bothReadsStarted = Promise.withResolvers<void>();
        let readsStarted = 0;

        vfs.open = async (access, ref, opts) => {
          const handle = await originalOpen.call(vfs, access, ref, opts);
          if (typeof ref !== 'string' || !paths.has(ref) || opts?.mode !== 'r') {
            return handle;
          }

          const originalRead = handle.read.bind(handle);
          let firstRead = true;
          handle.read = async (size, signal) => {
            if (firstRead) {
              firstRead = false;
              readsStarted++;
              if (readsStarted === paths.size) bothReadsStarted.resolve();

              const overlapped = await Promise.race([
                bothReadsStarted.promise.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
              ]);
              if (!overlapped) throw new Error('separate sftp handle reads did not overlap');
            }
            return await originalRead(size, signal);
          };
          return handle;
        };

        try {
          const downloads = await Promise.all([...paths].map((path) => sftp.readFile(path)));
          for (const downloaded of downloads) assertEquals(downloaded, data);
        } finally {
          vfs.open = originalOpen;
        }
      });

      await t.step('orders pipelined reads on the same handle', async () => {
        const chunkSize = 8 * 1024;
        const chunkCount = 8;
        const data = new Uint8Array(chunkSize * chunkCount);
        for (let i = 0; i < data.length; i++) data[i] = (i * 23 + 5) & 0xff;
        await sftp.writeFile('/home/admin/pipelined-read.bin', data);

        const vfs = harness.primary!.vfs;
        const originalOpen = vfs.open;
        let seekCount = 0;
        vfs.open = async (access, ref, opts) => {
          const resource = await originalOpen.call(vfs, access, ref, opts);
          if (ref !== '/home/admin/pipelined-read.bin' || opts?.mode !== 'r') {
            return resource;
          }
          const originalSeek = resource.seek.bind(resource);
          resource.seek = async (offset, whence) => {
            seekCount++;
            return await originalSeek(offset, whence);
          };
          return resource;
        };

        try {
          const handle = await sftp.open('/home/admin/pipelined-read.bin', 'r');
          try {
            const chunks = await Promise.all(
              Array.from({ length: chunkCount }, async (_, index) => {
                const chunk = new Uint8Array(chunkSize);
                const bytesRead = await sftp.read(
                  handle,
                  chunk,
                  0,
                  chunk.length,
                  index * chunkSize,
                );
                assertEquals(bytesRead, chunkSize);
                return chunk;
              }),
            );

            const downloaded = new Uint8Array(data.length);
            chunks.forEach((chunk, index) => downloaded.set(chunk, index * chunkSize));
            assertEquals(downloaded, data);

            // The initial cursor and every pipelined offset were sequential, so
            // none of those reads needed a syscall. A real reposition still does.
            const repeated = new Uint8Array(chunkSize);
            await sftp.read(handle, repeated, 0, repeated.length, 0);
            assertEquals(repeated, data.subarray(0, chunkSize));
            assertEquals(seekCount, 1);
          } finally {
            await sftp.close(handle);
          }
        } finally {
          vfs.open = originalOpen;
        }
      });

      await t.step('accepts a 256KiB read request', async () => {
        const requestedLength = 256 * 1024;
        const data = new Uint8Array(requestedLength);
        for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 11) & 0xff;
        await sftp.writeFile('/home/admin/openssh-buffer.bin', data);

        // The test client normally uses the conservative non-OpenSSH packet
        // size. Raise its request size to reproduce `sftp -X buffer=262144`.
        (sftp as unknown as { _maxReadLen: number })._maxReadLen = requestedLength;

        const handle = await sftp.open('/home/admin/openssh-buffer.bin', 'r');
        try {
          const downloaded = new Uint8Array(requestedLength);
          const firstLength = await sftp.read(
            handle,
            downloaded,
            0,
            requestedLength,
            0,
          );
          const secondLength = await sftp.read(
            handle,
            downloaded,
            firstLength,
            requestedLength - firstLength,
            firstLength,
          );

          assertEquals(firstLength + secondLength, requestedLength);
          assertEquals(downloaded, data);
        } finally {
          await sftp.close(handle);
        }
      });

      await t.step('removing a softlink leaves its target', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.writeFile('/home/admin/link-target.txt', new TextEncoder().encode('kept'));
        await vfs.create(ADMIN_ACCESS, NODE_TYPE_SOFTLINK, '/home/admin', 'to-target', {
          props: { softlink: '/home/admin/link-target.txt' },
        });

        await sftp.unlink('/home/admin/to-target');

        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/to-target', { follow: false }), false);
        const kept = await sftp.readFile('/home/admin/link-target.txt');
        assertEquals(new TextDecoder().decode(kept), 'kept');
      });

      await t.step('rmdir on a softlink to a directory fails and removes nothing', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.mkdir('/home/admin/link-dir');
        await vfs.create(ADMIN_ACCESS, NODE_TYPE_SOFTLINK, '/home/admin', 'to-dir', {
          props: { softlink: '/home/admin/link-dir' },
        });

        await assertRejects(() => sftp.rmdir('/home/admin/to-dir'));

        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/to-dir', { follow: false }), true);
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/link-dir'), true);
      });

      await t.step('lists softlinks as symlinks', async () => {
        const entries = await sftp.readdir('/home/admin');
        const link = entries.find((e) => e.filename === 'to-dir');
        const dir = entries.find((e) => e.filename === 'link-dir');

        assertEquals(fileType(link?.attrs.mode), S_IFLNK);
        assertEquals(link?.longname.startsWith('l'), true);
        assertEquals(fileType(dir?.attrs.mode), S_IFDIR);
        assertEquals(dir?.longname.startsWith('d'), true);
      });

      await t.step('creates a softlink', async () => {
        await sftp.writeFile('/home/admin/sym-target.txt', new TextEncoder().encode('through the link'));
        await sftp.symlink('sym-target.txt', '/home/admin/sym-link');

        const lstat = await sftp.lstat('/home/admin/sym-link');
        assertEquals(fileType(lstat.mode), S_IFLNK);
        assertEquals(await sftp.readlink('/home/admin/sym-link'), 'sym-target.txt');
        const content = await sftp.readFile('/home/admin/sym-link');
        assertEquals(new TextDecoder().decode(content), 'through the link');

        await assertRejects(() => sftp.symlink('sym-target.txt', '/home/admin/sym-link'));
      });

      await t.step('changes mode through an open handle', async () => {
        await sftp.writeFile('/home/admin/fchmod.txt', new TextEncoder().encode('x'));
        const handle = await sftp.open('/home/admin/fchmod.txt', 'r');
        try {
          await sftp.fchmod(handle, 0o640);
        } finally {
          await sftp.close(handle);
        }

        const stats = await sftp.stat('/home/admin/fchmod.txt');
        assertEquals((stats.mode ?? 0) & 0o7777, 0o640);
      });

      await t.step('removes a file together with what belongs to it, but not what a link there names', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.writeFile('/home/admin/outside.txt', new TextEncoder().encode('elsewhere'));
        await sftp.writeFile('/home/admin/with-children.txt', new TextEncoder().encode('x'));
        await vfs.create(ADMIN_ACCESS, 'directory', '/home/admin/with-children.txt', 'metadata');
        await vfs.create(ADMIN_ACCESS, NODE_TYPE_SOFTLINK, '/home/admin/with-children.txt', 'people', {
          props: { softlink: '/home/admin/outside.txt' },
        });

        await sftp.unlink('/home/admin/with-children.txt');

        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/with-children.txt'), false);
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/outside.txt'), true);
      });

      await t.step('remove on a directory fails and leaves it', async () => {
        await sftp.mkdir('/home/admin/not-a-file');
        await assertRejects(() => sftp.unlink('/home/admin/not-a-file'));
        assertEquals(fileType((await sftp.stat('/home/admin/not-a-file')).mode), S_IFDIR);
      });

      await t.step('reaches a shadow directory by name at any depth but never lists it', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.mkdir('/home/admin/album');
        await sftp.writeFile('/home/admin/album/beach.jpg', new TextEncoder().encode('jpeg'));
        await vfs.create(ADMIN_ACCESS, 'directory', '/home/admin/album/beach.jpg', 'metadata');
        await sftp.writeFile('/home/admin/album/beach.jpg_/metadata/exif.json', new TextEncoder().encode('{}'))
          .then(() => {
            throw new Error('write inside a shadow directory succeeded');
          }, () => {});
        await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, '/home/admin/album/beach.jpg/metadata', 'exif.json', {
          attrs: { name: 'exif.json', mimetype: 'application/json', size: 0 },
        });

        const listing = (await sftp.readdir('/home/admin/album')).map((e) => e.filename);
        assertEquals(listing, ['beach.jpg']);

        assertEquals(fileType((await sftp.stat('/home/admin/album/beach.jpg_')).mode), S_IFDIR);
        assertEquals(await sftp.realpath('/home/admin/album/beach.jpg_'), '/home/admin/album/beach.jpg_');
        assertEquals((await sftp.readdir('/home/admin/album/beach.jpg_')).map((e) => e.filename), ['metadata']);
        assertEquals(
          (await sftp.readdir('/home/admin/album/beach.jpg_/metadata')).map((e) => e.filename),
          ['exif.json'],
        );
        assertEquals(fileType((await sftp.stat('/home/admin/album/beach.jpg_/metadata/exif.json')).mode), S_IFREG);

        await assertRejects(() => sftp.mkdir('/home/admin/album/beach.jpg_/more'));
        await assertRejects(() => sftp.unlink('/home/admin/album/beach.jpg_/metadata/exif.json'));
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/album/beach.jpg/metadata/exif.json'), true);
      });

      await t.step('resolves a missing last segment under a directory that exists, as scp -r asks', async () => {
        await sftp.mkdir('/home/admin/drop');
        assertEquals(await sftp.realpath('/home/admin/drop/new-folder'), '/home/admin/drop/new-folder');
        await assertRejects(() => sftp.realpath('/home/admin/no-such/new-folder'));
      });

      await t.step('a real node named like a shadow wins over the shadow', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.writeFile('/home/admin/album/dune.jpg', new TextEncoder().encode('jpeg'));
        await vfs.create(ADMIN_ACCESS, 'directory', '/home/admin/album/dune.jpg', 'metadata');

        // While nothing is called `dune.jpg_`, the name is the file's shadow
        await assertRejects(() => sftp.mkdir('/home/admin/album/dune.jpg_'));

        // A node that already carries the name (made in the shell, say) wins
        await vfs.create(ADMIN_ACCESS, 'directory', '/home/admin/album', 'dune.jpg_');
        await sftp.writeFile('/home/admin/album/dune.jpg_/note.txt', new TextEncoder().encode('real'));
        assertEquals((await sftp.readdir('/home/admin/album/dune.jpg_')).map((e) => e.filename), ['note.txt']);
      });

      await t.step('reports when the content changed, not when metadata did', async () => {
        const vfs = harness.primary!.vfs;
        await sftp.writeFile('/home/admin/timed.txt', new TextEncoder().encode('t'));
        await vfs.update(ADMIN_ACCESS, '/home/admin/timed.txt', { attrs: { writtenAt: '2020-01-02T03:04:05.000Z' } });
        const at = Date.parse('2020-01-02T03:04:05.000Z') / 1000;
        assertEquals((await sftp.stat('/home/admin/timed.txt')).mtime, at);

        // A pipeline marker or any other attr moves props.modtime, not the time reported
        await vfs.update(ADMIN_ACCESS, '/home/admin/timed.txt', { attrs: { facesAt: new Date().toISOString() } });
        assertEquals((await sftp.stat('/home/admin/timed.txt')).mtime, at);

        await sftp.utimes('/home/admin/timed.txt', 1_600_000_000, 1_600_000_000);
        assertEquals((await sftp.stat('/home/admin/timed.txt')).mtime, 1_600_000_000);
      });

      await t.step('keeps a time set through the write handle (put -p)', async () => {
        const handle = await sftp.open('/home/admin/preserved.txt', 'w');
        await sftp.write(handle, new TextEncoder().encode('kept time'), 0, 9, 0);
        await sftp.futimes(handle, 1_500_000_000, 1_500_000_000);
        await sftp.close(handle);

        assertEquals((await sftp.stat('/home/admin/preserved.txt')).mtime, 1_500_000_000);
      });

      await t.step('truncates to zero and refuses a size it cannot apply', async () => {
        await sftp.writeFile('/home/admin/sized.txt', new TextEncoder().encode('hello'));

        await sftp.setstat('/home/admin/sized.txt', { size: 5 });
        await sftp.setstat('/home/admin/sized.txt', { size: 0 });
        assertEquals((await sftp.stat('/home/admin/sized.txt')).size, 0);
        assertEquals((await sftp.readFile('/home/admin/sized.txt')).length, 0);

        const err = await assertRejects(() => sftp.setstat('/home/admin/sized.txt', { size: 3 }));
        assertEquals((err as { code?: number }).code, STATUS_CODE.OP_UNSUPPORTED);
      });

      await t.step("fstat reports the node's mode and owner", async () => {
        await sftp.writeFile('/home/admin/owned.txt', new TextEncoder().encode('o'));
        await sftp.chmod('/home/admin/owned.txt', 0o600);
        const handle = await sftp.open('/home/admin/owned.txt', 'r');
        try {
          const stats = await sftp.fstat(handle);
          assertEquals((stats.mode ?? 0) & 0o7777, 0o600);
          assertEquals(fileType(stats.mode), S_IFREG);
          assertEquals(stats.size, 1);
        } finally {
          await sftp.close(handle);
        }
      });

      await t.step('closes the subsystem channel after client EOF', async () => {
        // OpenSSH finishes a one-shot transfer by half-closing its channel and
        // waiting for the server's CHANNEL_CLOSE. ssh2's high-level SFTP.end()
        // sends CHANNEL_CLOSE directly, so use the protocol seam to reproduce
        // OpenSSH's EOF-first teardown.
        const protocol = (client as unknown as {
          _protocol?: { channelEOF(id: number): void };
        })._protocol;
        if (!protocol || sftp.outgoing.id === undefined) {
          throw new Error('sftp protocol channel is unavailable');
        }

        protocol.channelEOF(sftp.outgoing.id);

        const deadline = Date.now() + 1_000;
        while (sftp.incoming.state !== 'closed' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(sftp.incoming.state, 'closed');
      });
    } finally {
      client.end();
    }
  } finally {
    await harness.stop();
  }
});

/** Whether `name` runs here: the scp test needs OpenSSH's scp and sshpass on the machine. */
const runs = (name: string): boolean => {
  try {
    return new Deno.Command('which', { args: [name], stdout: 'null', stderr: 'null' }).outputSync().success;
  } catch {
    return false;
  }
};

Deno.test({
  name: 'OpenSSH scp copies a file and reports success',
  ignore: !runs('scp') || !runs('sshpass'),
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const scpHarness = new SystemTestHarness();
  const { vfs } = await scpHarness.startPrimary();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/note.txt`, 'a sailboat at the jetty\n');
    // scp ends the session and reads its exit status: without one it fails the copy.
    const { code, stderr } = await new Deno.Command('sshpass', {
      args: [
        '-p',
        'admin',
        'scp',
        '-P',
        String(scpHarness.primary!.sshPort),
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        `${dir}/note.txt`,
        'admin@localhost:/home/admin/note.txt',
      ],
      stdout: 'null',
      stderr: 'piped',
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assertEquals((await vfs.get(ADMIN_ACCESS, '/home/admin/note.txt')).attrs.size, 24);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await scpHarness.stop();
  }
});
