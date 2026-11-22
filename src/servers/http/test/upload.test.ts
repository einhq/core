/**
 * Uploads in pieces at /upload/ (tus 1.0): begun, sent in pieces, resumed from what arrived, stored
 * in one write under a free name, and each account's own.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { encodeBase64, encodeHex } from '@std/encoding';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

const sha256Hex = async (data: Uint8Array) => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)));

const metadata = (pairs: Record<string, string>): string => Object.entries(pairs).map(([key, value]) => `${key} ${encodeBase64(value)}`).join(',');

const bytes = (length: number, seed = 0): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);

Deno.test({
  name: 'uploads in pieces',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs } = await harness.start();
  const { cookie } = await harness.createHttpSession();
  const tus = { 'Tus-Resumable': '1.0.0', cookie };

  const begin = async (pairs: Record<string, string>, length: number, headers: Record<string, string> = tus): Promise<Response> =>
    await fetch(`${baseUrl}/upload/`, { method: 'POST', headers: { ...headers, 'Upload-Length': String(length), 'Upload-Metadata': metadata(pairs) } });

  const patch = async (location: string, offset: number, body: BodyInit, headers: Record<string, string> = tus): Promise<Response> =>
    await fetch(`${baseUrl}${location}`, {
      method: 'PATCH',
      headers: { ...headers, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
      body,
    });

  const head = async (location: string, headers: Record<string, string> = tus): Promise<Response> => {
    const res = await fetch(`${baseUrl}${location}`, { method: 'HEAD', headers });
    await res.body?.cancel();
    return res;
  };

  try {
    await t.step('OPTIONS says the version, the extensions and the largest upload', async () => {
      const res = await fetch(`${baseUrl}/upload/`, { method: 'OPTIONS' });
      await res.body?.cancel();
      assertEquals(res.status, 204);
      assertEquals(res.headers.get('tus-version'), '1.0.0');
      assertEquals(res.headers.get('tus-extension'), 'creation,expiration,termination');
      assert(Number(res.headers.get('tus-max-size')) > 0);
    });

    await t.step('a request without Tus-Resumable, or from the guest, is refused', async () => {
      const res = await begin({ filename: 'a.bin', dir: '/tmp' }, 10, { cookie });
      await res.body?.cancel();
      assertEquals(res.status, 412);
      assertEquals(res.headers.get('tus-version'), '1.0.0');

      const guest = await begin({ filename: 'a.bin', dir: '/tmp' }, 10, { 'Tus-Resumable': '1.0.0' });
      await guest.body?.cancel();
      assertEquals(guest.status, 401);
    });

    await t.step('an upload sent in two pieces is stored whole, once, with its sha256', async () => {
      const content = bytes(300_000);
      const created = await begin({ filename: 'video.mp4', dir: '/tmp/', mtime: '1700000000' }, content.length);
      await created.body?.cancel();
      assertEquals(created.status, 201);
      const location = created.headers.get('location')!;
      assertMatch(location, /^\/upload\/[0-9A-Z]{26}$/);
      assert(created.headers.get('upload-expires'));
      assertEquals((await head(location)).headers.get('upload-offset'), '0');

      const first = await patch(location, 0, content.subarray(0, 100_000));
      await first.body?.cancel();
      assertEquals(first.status, 204);
      assertEquals(first.headers.get('upload-offset'), '100000');
      assertEquals(first.headers.get('content-location'), null);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/tmp/video.mp4'), false);

      const state = await head(location);
      assertEquals(state.status, 200);
      assertEquals(state.headers.get('upload-offset'), '100000');
      assertEquals(state.headers.get('upload-length'), String(content.length));
      assertEquals(state.headers.get('cache-control'), 'no-store');

      const wrong = await patch(location, 0, content.subarray(0, 10));
      await wrong.body?.cancel();
      assertEquals(wrong.status, 409);

      const last = await patch(location, 100_000, content.subarray(100_000));
      await last.body?.cancel();
      assertEquals(last.status, 204);
      assertEquals(last.headers.get('upload-offset'), String(content.length));
      assertEquals(last.headers.get('content-location'), '/file/tmp/video.mp4');

      const node = await vfs.get(ADMIN_ACCESS, '/tmp/video.mp4');
      assertEquals(node.attrs.size, content.length);
      assertEquals(node.attrs.sha256, await sha256Hex(content));
      assertEquals(node.attrs.writtenAt, new Date(1700000000_000).toISOString());
      const stored = await fetch(`${baseUrl}/file/tmp/video.mp4`, { headers: { cookie } });
      assertEquals(new Uint8Array(await stored.arrayBuffer()), content);

      // A sender that missed the last answer asks again and is told it is done, and where.
      const after = await head(location);
      assertEquals(after.headers.get('upload-offset'), String(content.length));
      assertEquals(after.headers.get('content-location'), '/file/tmp/video.mp4');
      const again = await patch(location, content.length, new Uint8Array(0));
      await again.body?.cancel();
      assertEquals(again.status, 204);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/tmp', { filter: { name: 'video*' } })).length, 1);
    });

    await t.step('a taken name is numbered, never replaced', async () => {
      const created = await begin({ filename: 'video.mp4', dir: '/tmp' }, 5);
      await created.body?.cancel();
      const res = await patch(created.headers.get('location')!, 0, 'other');
      await res.body?.cancel();
      assertEquals(res.headers.get('content-location'), `/file/tmp/${encodeURIComponent('video (2).mp4')}`);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/video.mp4')).attrs.size, 300_000);
    });

    await t.step('a piece that breaks off keeps what arrived, and the upload goes on from there', async () => {
      const content = bytes(50_000, 7);
      const created = await begin({ filename: 'broken.bin', dir: '/tmp' }, content.length);
      await created.body?.cancel();
      const location = created.headers.get('location')!;

      let fail!: (reason: Error) => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content.subarray(0, 20_000));
          fail = (reason) => controller.error(reason);
        },
      });
      const sending = patch(location, 0, body).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      fail(new Error('the connection dropped'));
      await sending;

      const state = await head(location);
      assertEquals(state.headers.get('upload-offset'), '20000');
      const rest = await patch(location, 20_000, content.subarray(20_000));
      await rest.body?.cancel();
      assertEquals(rest.status, 204);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/broken.bin')).attrs.sha256, await sha256Hex(content));
    });

    await t.step('asking again stops a piece whose connection stalled, at what had arrived', async () => {
      const created = await begin({ filename: 'stalled.bin', dir: '/tmp' }, 30_000);
      await created.body?.cancel();
      const location = created.headers.get('location')!;

      const stalled = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(bytes(10_000)) });
      const sending = patch(location, 0, stalled).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const state = await head(location);
      assertEquals(state.status, 200);
      assertEquals(state.headers.get('upload-offset'), '10000');
      await stalled.cancel().catch(() => {});
      await sending;
    });

    await t.step('an empty upload is stored when it begins', async () => {
      const created = await begin({ filename: 'empty.txt', dir: '/tmp' }, 0);
      await created.body?.cancel();
      assertEquals(created.status, 201);
      assertEquals(created.headers.get('upload-offset'), '0');
      assertEquals(created.headers.get('content-location'), '/file/tmp/empty.txt');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/empty.txt')).attrs.size, 0);
    });

    await t.step('another account does not see the upload, and DELETE gives it up', async () => {
      const created = await begin({ filename: 'mine.bin', dir: '/tmp' }, 10);
      await created.body?.cancel();
      const location = created.headers.get('location')!;

      const other = await harness.createHttpSession({ uid: 4242, gid: 4242, gids: [4242] });
      assertEquals((await head(location, { 'Tus-Resumable': '1.0.0', cookie: other.cookie })).status, 404);

      const gone = await fetch(`${baseUrl}${location}`, { method: 'DELETE', headers: tus });
      await gone.body?.cancel();
      assertEquals(gone.status, 204);
      assertEquals((await head(location)).status, 404);
    });

    await t.step('an upload is refused before it starts where it cannot land', async () => {
      const other = await harness.createHttpSession({ uid: 4242, gid: 4242, gids: [4242] });
      const asOther = { 'Tus-Resumable': '1.0.0', cookie: other.cookie };
      const cases: [Record<string, string>, number, Record<string, string>, number][] = [
        [{ filename: 'x.bin', dir: '/etc' }, 10, asOther, 403],
        [{ filename: 'x.bin', dir: '/no/such/folder' }, 10, tus, 404],
        [{ filename: 'x.bin', dir: '/tmp/video.mp4' }, 10, tus, 409],
        [{ filename: 'a/b.bin', dir: '/tmp' }, 10, tus, 400],
        [{ filename: 'x.bin' }, 10, tus, 400],
        [{ filename: 'x.bin', dir: '/tmp' }, 10 ** 15, tus, 413],
      ];
      for (const [pairs, length, headers, status] of cases) {
        const res = await begin(pairs, length, headers);
        await res.body?.cancel();
        assertEquals(res.status, status, JSON.stringify(pairs));
      }
    });

    await t.step('a piece not sent as application/offset+octet-stream is refused', async () => {
      const created = await begin({ filename: 'typed.bin', dir: '/tmp' }, 3);
      await created.body?.cancel();
      const res = await fetch(`${baseUrl}${created.headers.get('location')}`, {
        method: 'PATCH',
        headers: { ...tus, 'Upload-Offset': '0', 'Content-Type': 'application/octet-stream' },
        body: 'abc',
      });
      await res.body?.cancel();
      assertEquals(res.status, 415);
    });
  } finally {
    await harness.stop();
  }
});
