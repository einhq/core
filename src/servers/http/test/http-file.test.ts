/**
 * HTTP file upload/download: PUT /file/<path> and GET/HEAD /file/<path>,
 * mimetype sniffing, sha256/size, ETag caching and permission mapping.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { encodeHex } from '@std/encoding';
import { ADMIN_ACCESS, GUEST_GID, GUEST_UID } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

// Tiny valid PNG (1x1 transparent pixel)
const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

Deno.test({
  name: 'HTTP file endpoints',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs, cem, shell } = await harness.startPrimary();
  const { cookie } = await harness.createHttpSession();
  void cem;
  void shell;

  try {
    await t.step('PUT creates a file node with size, sha256 and mimetype', async () => {
      const body = new TextEncoder().encode('hello upload\n');
      const res = await fetch(`${baseUrl}/file/tmp/hello.txt`, {
        method: 'PUT',
        headers: { cookie },
        body,
      });

      assertEquals(res.status, 201);
      const attrs = await res.json();
      assertEquals(attrs.size, body.length);
      assertEquals(attrs.sha256, encodeHex(sha256.create().update(body).digest()));
      assertEquals(attrs.mimetype.startsWith('text/'), true);
    });

    await t.step('PUT sniffs binary mimetypes from content', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/pixel.png`, {
        method: 'PUT',
        headers: { cookie },
        body: PNG_BYTES,
      });

      assertEquals(res.status, 201);
      const attrs = await res.json();
      assertEquals(attrs.mimetype, 'image/png');
      assertEquals(attrs.size, PNG_BYTES.length);
    });

    await t.step('an upload of a type /etc/frozen-uploads lists is frozen, and a PUT over it refused', async () => {
      // The seed boot copies to /etc, which this instance does not boot to
      const seed = await Deno.readFile(new URL('../../../builtin/core/etc/frozen-uploads', import.meta.url));
      await vfs.create(ADMIN_ACCESS, 'file', '/etc', 'frozen-uploads', { attrs: { name: 'frozen-uploads' } });
      const handle = await vfs.open(ADMIN_ACCESS, '/etc/frozen-uploads', { mode: 'w' });
      await handle.write(seed);
      await handle.close();

      try {
        for (const [name, body] of [['frozen.png', PNG_BYTES], ['notes.txt', new TextEncoder().encode('a note\n')]] as const) {
          assertEquals((await fetch(`${baseUrl}/file/tmp/?name=${name}`, { method: 'POST', headers: { cookie }, body })).status, 201);
        }
        assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/frozen.png')).attrs.frozen, true);
        assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/notes.txt')).attrs.frozen, undefined);

        const res = await fetch(`${baseUrl}/file/tmp/frozen.png`, { method: 'PUT', headers: { cookie }, body: 'replaced' });
        assertEquals(res.status, 403);
        assertStringIncludes(await res.text(), 'frozen');
        assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/frozen.png')).attrs.size, PNG_BYTES.length);
      } finally {
        await vfs.unlink(ADMIN_ACCESS, '/etc/frozen-uploads', '/etc');
      }
    });

    await t.step('a camera RAW name decides over a sniff of text or TIFF', async () => {
      // A RAF opens with an ASCII header, an uncompressed NEF is a plain TIFF
      const raf = new Uint8Array(256);
      raf.set(new TextEncoder().encode('FUJIFILMCCD-RAW 0201FF116501X-Pr'));
      const tiff = new Uint8Array(64);
      tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

      const uploads = [['DSCF0001.RAF', raf, 'image/x-fujifilm-raf'], ['DSC_0001.NEF', tiff, 'image/x-nikon-nef'], ['scan.tif', tiff, 'image/tiff']] as const;
      for (const [name, body, mimetype] of uploads) {
        const res = await fetch(`${baseUrl}/file/tmp/?name=${name}`, { method: 'POST', headers: { cookie }, body });
        assertEquals(res.status, 201);
        assertEquals((await res.json()).mimetype, mimetype, name);
        assertEquals((await vfs.get(ADMIN_ACCESS, `/tmp/${name}`)).attrs.mimetype, mimetype, name);
      }
    });

    await t.step('GET returns byte-exact content with ETag', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/pixel.png`, { headers: { cookie } });

      assertEquals(res.status, 200);
      assertEquals(res.headers.get('content-type'), 'image/png');

      const body = new Uint8Array(await res.arrayBuffer());
      assertEquals(body, PNG_BYTES);

      const etag = res.headers.get('etag');
      assertEquals(etag !== null, true);
    });

    await t.step('HEAD returns the GET headers without a body', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/pixel.png`, {
        method: 'HEAD',
        headers: { cookie },
      });

      assertEquals(res.status, 200);
      assertEquals(res.headers.get('content-type'), 'image/png');
      assertEquals(res.headers.get('content-length'), PNG_BYTES.length.toString());
      assertEquals(res.headers.get('accept-ranges'), 'bytes');
      assertEquals(res.headers.get('etag') !== null, true);
      assertEquals((await res.arrayBuffer()).byteLength, 0);
    });

    await t.step('GET with If-None-Match returns 304', async () => {
      const first = await fetch(`${baseUrl}/file/tmp/hello.txt`, { headers: { cookie } });
      await first.arrayBuffer();
      const etag = first.headers.get('etag')!;

      const second = await fetch(`${baseUrl}/file/tmp/hello.txt`, {
        headers: { cookie, 'if-none-match': etag },
      });
      assertEquals(second.status, 304);
      await second.body?.cancel();
    });

    await t.step('PUT overwrite updates size and sha256', async () => {
      const body = new TextEncoder().encode('v2');
      const res = await fetch(`${baseUrl}/file/tmp/hello.txt`, {
        method: 'PUT',
        headers: { cookie },
        body,
      });

      assertEquals(res.status, 201);
      const attrs = await res.json();
      assertEquals(attrs.size, 2);

      const back = await fetch(`${baseUrl}/file/tmp/hello.txt`, { headers: { cookie } });
      assertEquals(await back.text(), 'v2');
    });

    await t.step('POST stores an upload under the name asked for', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/?name=IMG_0001.jpg`, { method: 'POST', headers: { cookie }, body: 'first camera' });

      assertEquals(res.status, 201);
      const answer = await res.json();
      assertEquals(answer.path, '/tmp/IMG_0001.jpg');
      assertEquals(answer.renamed, false);
      assertEquals(answer.size, 'first camera'.length);
      assertEquals(res.headers.get('location'), '/file/tmp/IMG_0001.jpg');
    });

    await t.step('POST of a taken name stores a numbered file and keeps the first', async () => {
      const res = await fetch(`${baseUrl}/file/tmp?name=IMG_0001.jpg`, { method: 'POST', headers: { cookie }, body: 'second camera' });

      assertEquals(res.status, 201);
      const answer = await res.json();
      assertEquals(answer.path, '/tmp/IMG_0001 (2).jpg');
      assertEquals(answer.renamed, true);
      assertEquals(res.headers.get('location'), '/file/tmp/IMG_0001%20(2).jpg');

      assertEquals(await (await fetch(`${baseUrl}/file/tmp/IMG_0001.jpg`, { headers: { cookie } })).text(), 'first camera');
      assertEquals(await (await fetch(`${baseUrl}/file/tmp/IMG_0001%20(2).jpg`, { headers: { cookie } })).text(), 'second camera');
    });

    await t.step('concurrent POSTs of one name each get a file of their own', async () => {
      const bodies = ['one', 'two', 'three', 'four', 'five'];
      const answers = await Promise.all(
        bodies.map(async (body) => {
          const res = await fetch(`${baseUrl}/file/tmp/?name=same.txt`, { method: 'POST', headers: { cookie }, body });
          assertEquals(res.status, 201);
          return await res.json() as { path: string };
        }),
      );

      const paths = answers.map((a) => a.path);
      assertEquals(new Set(paths).size, bodies.length);
      const stored = await Promise.all(paths.map(async (p) => await (await fetch(`${baseUrl}/file${encodeURI(p)}`, { headers: { cookie } })).text()));
      assertEquals(stored.sort(), [...bodies].sort());
    });

    await t.step('POST without a name is 400, into a missing directory 404', async () => {
      for (const query of ['', '?name=', '?name=a/b.txt', '?name=..']) {
        const res = await fetch(`${baseUrl}/file/tmp/${query}`, { method: 'POST', headers: { cookie }, body: 'x' });
        await res.body?.cancel();
        assertEquals(res.status, 400, query);
      }

      const missing = await fetch(`${baseUrl}/file/no/such/dir/?name=file.txt`, { method: 'POST', headers: { cookie }, body: 'x' });
      await missing.body?.cancel();
      assertEquals(missing.status, 404);
    });

    // Range support is what lets <video> seek: without it the browser has to buffer the
    // whole transcode before a scrub works.
    await t.step('GET advertises Accept-Ranges and serves a closed range as 206', async () => {
      const body = new TextEncoder().encode('0123456789abcdef');
      await (await fetch(`${baseUrl}/file/tmp/ranged.bin`, { method: 'PUT', headers: { cookie }, body })).json();

      const full = await fetch(`${baseUrl}/file/tmp/ranged.bin`, { headers: { cookie } });
      assertEquals(full.status, 200);
      assertEquals(full.headers.get('accept-ranges'), 'bytes');
      assertEquals(full.headers.get('content-length'), '16');
      assertEquals(await full.text(), '0123456789abcdef');

      const res = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, range: 'bytes=4-9' },
      });
      assertEquals(res.status, 206);
      assertEquals(res.headers.get('content-range'), 'bytes 4-9/16');
      assertEquals(res.headers.get('content-length'), '6');
      assertEquals(await res.text(), '456789');
    });

    await t.step('open-ended and suffix ranges resolve against the size', async () => {
      const openEnded = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, range: 'bytes=10-' },
      });
      assertEquals(openEnded.status, 206);
      assertEquals(openEnded.headers.get('content-range'), 'bytes 10-15/16');
      assertEquals(await openEnded.text(), 'abcdef');

      const suffix = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, range: 'bytes=-4' },
      });
      assertEquals(suffix.status, 206);
      assertEquals(suffix.headers.get('content-range'), 'bytes 12-15/16');
      assertEquals(await suffix.text(), 'cdef');

      // An end past the last byte is clamped, not rejected
      const clamped = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, range: 'bytes=14-999' },
      });
      assertEquals(clamped.status, 206);
      assertEquals(clamped.headers.get('content-range'), 'bytes 14-15/16');
      assertEquals(await clamped.text(), 'ef');
    });

    await t.step('HEAD with a range returns partial GET headers without a body', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        method: 'HEAD',
        headers: { cookie, range: 'bytes=4-9' },
      });

      assertEquals(res.status, 206);
      assertEquals(res.headers.get('content-range'), 'bytes 4-9/16');
      assertEquals(res.headers.get('content-length'), '6');
      assertEquals((await res.arrayBuffer()).byteLength, 0);
    });

    await t.step('a start past the end is 416, an unparseable range is ignored', async () => {
      const past = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, range: 'bytes=16-20' },
      });
      assertEquals(past.status, 416);
      assertEquals(past.headers.get('content-range'), 'bytes */16');
      await past.body?.cancel();

      // Multi-range and other units fall through to a plain 200 rather than failing
      for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=abc']) {
        const res = await fetch(`${baseUrl}/file/tmp/ranged.bin`, { headers: { cookie, range } });
        assertEquals(res.status, 200, range);
        assertEquals(await res.text(), '0123456789abcdef', range);
      }
    });

    await t.step('If-None-Match still wins over Range', async () => {
      const first = await fetch(`${baseUrl}/file/tmp/ranged.bin`, { headers: { cookie } });
      await first.arrayBuffer();
      const etag = first.headers.get('etag')!;

      const res = await fetch(`${baseUrl}/file/tmp/ranged.bin`, {
        headers: { cookie, 'if-none-match': etag, range: 'bytes=0-3' },
      });
      assertEquals(res.status, 304);
      await res.body?.cancel();
    });

    /**
     * A rendition (anything carrying `sourceId`) is regenerable and lives at a stable URL,
     * so it gets a freshness lifetime. An original does not: it is the thing being kept,
     * and a wrong lifetime there cannot be fixed by regenerating.
     */
    await t.step('a rendition is cacheable, an original is not', async () => {
      await fetch(`${baseUrl}/file/tmp/rendition.txt`, {
        method: 'PUT',
        headers: { cookie },
        body: new TextEncoder().encode('a derivative\n'),
      });
      await vfs.update(ADMIN_ACCESS, '/tmp/rendition.txt', { attrs: { sourceId: 'some-node-id' } });

      const rendition = await fetch(`${baseUrl}/file/tmp/rendition.txt`, { headers: { cookie } });
      await rendition.body?.cancel();
      assertEquals(rendition.headers.get('cache-control'), 'private, max-age=3600, stale-while-revalidate=86400');

      const original = await fetch(`${baseUrl}/file/tmp/hello.txt`, { headers: { cookie } });
      await original.body?.cancel();
      assertEquals(original.headers.get('cache-control'), null);
    });

    await t.step('a file named by its content is cached for good', async () => {
      await fetch(`${baseUrl}/file/tmp/0123abcd.js`, { method: 'PUT', headers: { cookie }, body: new TextEncoder().encode('export {};\n') });
      await vfs.update(ADMIN_ACCESS, '/tmp/0123abcd.js', { attrs: { immutable: true } });
      const res = await fetch(`${baseUrl}/file/tmp/0123abcd.js`, { headers: { cookie } });
      await res.body?.cancel();
      assertEquals(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    });

    /**
     * A 304 that carries no Cache-Control leaves the entry stale the instant it lands, so
     * the next request revalidates again and the lifetime never applies to the requests it
     * exists for. The ETag has to come back too, or the browser has nothing to store.
     */
    await t.step('a 304 still carries the caching headers', async () => {
      const first = await fetch(`${baseUrl}/file/tmp/rendition.txt`, { headers: { cookie } });
      await first.body?.cancel();
      const etag = first.headers.get('etag');

      const revalidated = await fetch(`${baseUrl}/file/tmp/rendition.txt`, {
        headers: { cookie, 'if-none-match': etag ?? '' },
      });
      await revalidated.body?.cancel();

      assertEquals(revalidated.status, 304);
      assertEquals(revalidated.headers.get('etag'), etag);
      assertEquals(revalidated.headers.get('cache-control'), 'private, max-age=3600, stale-while-revalidate=86400');
    });

    /**
     * A rendition of exactly 0 bytes is a converter that produced nothing, and `file-sync`
     * recording that faithfully makes the node self-consistent — so nothing else flags it.
     * Served as a 200 it is worse than a 404: the UI's fallback chain only steps down a level
     * on a 404, so an empty `application/octet-stream` gets mounted over the poster and the
     * browser reports a decode error instead.
     *
     * An empty ORIGINAL is not the same thing — someone may upload a 0-byte file, and that
     * is the file, so it keeps its honest 200.
     */
    await t.step('an empty rendition is 404, an empty original is 200', async () => {
      for (const name of ['empty-rendition.bin', 'empty-original.bin']) {
        const put = await fetch(`${baseUrl}/file/tmp/${name}`, {
          method: 'PUT',
          headers: { cookie },
          body: new Uint8Array(0),
        });
        await put.body?.cancel();
      }
      await vfs.update(ADMIN_ACCESS, '/tmp/empty-rendition.bin', { attrs: { sourceId: 'some-node-id' } });

      const attrs = (await vfs.get(ADMIN_ACCESS, '/tmp/empty-rendition.bin')).attrs as { size: number };
      assertEquals(attrs.size, 0, 'the node must really be 0 bytes for this to test anything');

      const rendition = await fetch(`${baseUrl}/file/tmp/empty-rendition.bin`, { headers: { cookie } });
      await rendition.body?.cancel();
      assertEquals(rendition.status, 404);

      const original = await fetch(`${baseUrl}/file/tmp/empty-original.bin`, { headers: { cookie } });
      await original.body?.cancel();
      assertEquals(original.status, 200);
      assertEquals(original.headers.get('content-length'), '0');
    });

    /**
     * The absent check runs before the conditional, so a browser that cached the bad 200
     * cannot revalidate its way back to it. Answering `if-none-match` first would hand it a
     * 304 forever — the empty body would outlive the backfill that fixes the rendition.
     */
    await t.step('an empty rendition 404s a revalidation rather than answering 304', async () => {
      const emptySha = encodeHex(sha256(new Uint8Array(0)));
      const res = await fetch(`${baseUrl}/file/tmp/empty-rendition.bin`, {
        headers: { cookie, 'if-none-match': `"${emptySha}"` },
      });
      await res.body?.cancel();
      assertEquals(res.status, 404);
    });

    await t.step('GET of missing file returns 404', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/does-not-exist.txt`, { headers: { cookie } });
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    await t.step('PUT into missing parent returns 404', async () => {
      const res = await fetch(`${baseUrl}/file/no/such/dir/file.txt`, {
        method: 'PUT',
        headers: { cookie },
        body: 'x',
      });
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    await t.step('guest PUT into admin-only directory returns 403', async () => {
      const { cookie: guestCookie } = await harness.createHttpSession({
        uid: GUEST_UID,
        gid: GUEST_GID,
        gids: [GUEST_GID],
      });

      // /home is admin-owned 0o755 — guests cannot create files there
      const res = await fetch(`${baseUrl}/file/home/intruder.txt`, {
        method: 'PUT',
        headers: { cookie: guestCookie },
        body: 'nope',
      });
      assertEquals(res.status, 403);
      await res.body?.cancel();
    });

    await t.step('a request without a cookie stores nothing, not even in the guest home', async () => {
      // The guest owns its home, as the boot's auth script creates it
      const client = await harness.createShellClient();
      await client.exec(`user-exists guest || user-create guest --uid ${GUEST_UID}`);

      const post = await fetch(`${baseUrl}/file/home/guest/?name=anon.txt`, { method: 'POST', body: 'x' });
      assertEquals(post.status, 403);
      await post.body?.cancel();

      const put = await fetch(`${baseUrl}/file/tmp/anon.txt`, { method: 'PUT', body: 'x' });
      assertEquals(put.status, 403);
      await put.body?.cancel();

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/guest/anon.txt'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/tmp/anon.txt'), false);
    });

    await t.step('request without cookie is served as a guest, without minting a session', async () => {
      // Visitors are asked to sign in here, so the guest is refused `/file`.
      const res = await fetch(`${baseUrl}/file/tmp/hello.txt`);
      assertEquals(res.status, 401);
      await res.arrayBuffer();

      // An asset fetch only needs to know who is asking, and without a cookie
      // the answer is "a guest" either way. The cookie comes from the SPA
      // document instead.
      assertEquals(res.headers.get('set-cookie'), null);
    });
  } finally {
    await harness.stop();
  }
});
