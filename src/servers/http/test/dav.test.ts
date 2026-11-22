/**
 * WebDAV at /dav: Basic sign-in and what it remembers, PROPFIND, PUT, MKCOL, MOVE as sync apps
 * upload (a temporary name, then a move onto the real one), DELETE into the trash, PROPPATCH, and
 * the refusals: frozen uploads, the trash, other origins, other people's folders.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { encodeHex } from '@std/encoding';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { setAccountPassword } from '../../../lib/auth/account-password.ts';
import { HOME_MODE, HOMES_PATH, USERS_PATH } from '../../../lib/paths.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { NodeVFS } from '../../../vfs/mod.ts';
import { NODE_TYPE_SOFTLINK } from '../../../vfs/types/softlink.ts';
import type { UserAttrs } from '../../../vfs/types/user.ts';

const harness = new SystemTestHarness({ ssh: false });

// A 1x1 transparent PNG.
const PNG_BYTES = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const sha256Hex = async (data: Uint8Array) => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)));

const basic = (bytes: Uint8Array): string => `Basic ${btoa(String.fromCharCode(...bytes))}`;
const utf8Auth = (login: string, password: string): string => basic(new TextEncoder().encode(`${login}:${password}`));
const latin1Auth = (login: string, password: string): string => basic(Uint8Array.from(`${login}:${password}`, (char) => char.charCodeAt(0)));

const PASSWORD_ENV = { CFG_PASSWORD_HASH_LOGN: '10' };

/** An account with a home and a password, as `user-create` makes one. */
async function makeAccount(vfs: NodeVFS, username: string, uid: number, password: string): Promise<void> {
  await vfs.create<UserAttrs>(ADMIN_ACCESS, 'user', USERS_PATH, username, { props: { mode: 0o755 }, attrs: { name: username, uid, gid: uid } });
  await vfs.ensure(ADMIN_ACCESS, 'directory', HOMES_PATH, username, { props: { mode: HOME_MODE, uid, gid: uid } });
  await setAccountPassword(vfs, ADMIN_ACCESS, join(USERS_PATH, username), password, PASSWORD_ENV);
}

const PROPFIND_ETAG = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><x:colour xmlns:x="urn:example:x"/></d:prop></d:propfind>';

Deno.test({
  name: 'WebDAV',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs, httpPort } = await harness.start();
  // The harness starts without the seeded `/etc/frozen-uploads`; an install has it.
  const seed = await Deno.readFile(new URL('../../../builtin/core/etc/frozen-uploads', import.meta.url));
  await vfs.create(ADMIN_ACCESS, 'file', '/etc', 'frozen-uploads', { attrs: { name: 'frozen-uploads' } });
  const handle = await vfs.open(ADMIN_ACCESS, '/etc/frozen-uploads', { mode: 'w' });
  await handle.write(seed);
  await handle.close();
  await makeAccount(vfs, 'anna', 4101, 'sailboat');
  await makeAccount(vfs, 'cecilia', 4102, 'blåbär');
  let annaAuth = utf8Auth('anna', 'sailboat');

  const dav = (method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) =>
    fetch(`${baseUrl}${path}`, { method, headers: { authorization: annaAuth, ...init.headers }, body: init.body });
  const signIns = async (uid: number) => (await vfs.accessLog(ADMIN_ACCESS, { uid, events: ['sign-in'], limit: 1000 })).filter((r) => r.via === 'dav').length;

  try {
    await t.step('OPTIONS answers without a sign-in and names class 1', async () => {
      const res = await fetch(`${baseUrl}/dav/`, { method: 'OPTIONS' });
      await res.body?.cancel();
      assertEquals(res.status, 200);
      assertEquals(res.headers.get('dav'), '1');
      assertStringIncludes(res.headers.get('allow') ?? '', 'PROPFIND');
    });

    await t.step('without credentials, or with only a session cookie, it asks for Basic', async () => {
      const bare = await fetch(`${baseUrl}/dav/home/anna/`, { method: 'PROPFIND' });
      await bare.body?.cancel();
      assertEquals(bare.status, 401);
      assertStringIncludes(bare.headers.get('www-authenticate') ?? '', 'Basic realm="EiN"');

      const { cookie } = await harness.createHttpSession();
      const withCookie = await fetch(`${baseUrl}/dav/home/anna/`, { method: 'PROPFIND', headers: { cookie } });
      await withCookie.body?.cancel();
      assertEquals(withCookie.status, 401);
    });

    await t.step('a page of another origin is refused, credentials or not', async () => {
      for (const headers of [{ origin: 'http://other.example' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
        const res = await dav('PROPFIND', '/dav/home/anna/', { headers });
        await res.body?.cancel();
        assertEquals(res.status, 403);
      }
    });

    await t.step('MKCOL makes a folder, once, under a folder that exists, without a body', async () => {
      const made = await dav('MKCOL', '/dav/home/anna/phone');
      await made.body?.cancel();
      assertEquals(made.status, 201);
      const again = await dav('MKCOL', '/dav/home/anna/phone');
      await again.body?.cancel();
      assertEquals(again.status, 405);
      const orphan = await dav('MKCOL', '/dav/home/anna/missing/below');
      await orphan.body?.cancel();
      assertEquals(orphan.status, 409);
      const withBody = await dav('MKCOL', '/dav/home/anna/other', { body: '<x/>' });
      await withBody.body?.cancel();
      assertEquals(withBody.status, 415);
    });

    const sha = await sha256Hex(PNG_BYTES);

    await t.step('an upload under a temporary name, moved onto its own, is a frozen picture', async () => {
      const put = await dav('PUT', '/dav/home/anna/phone/PXL_0001.png.tacitpart', { body: PNG_BYTES });
      await put.body?.cancel();
      assertEquals(put.status, 201);
      assertEquals(put.headers.get('etag'), `"${sha}"`);
      const uploaded = await vfs.get(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png.tacitpart');

      // As a client behind a TLS proxy names it: another scheme and host than EiN sees.
      const move = await dav('MOVE', '/dav/home/anna/phone/PXL_0001.png.tacitpart', {
        headers: { destination: 'https://ein.wrenfield.example/dav/home/anna/phone/PXL_0001.png', overwrite: 'T' },
      });
      await move.body?.cancel();
      assertEquals(move.status, 201);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png.tacitpart'), false);
      const moved = await vfs.get(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png');
      assertEquals(moved.id, uploaded.id);
      assertEquals(moved.attrs.mimetype, 'image/png');
      assertEquals(moved.attrs.size, PNG_BYTES.length);
      assertEquals(moved.attrs.frozen, true);
      assertEquals(moved.attrs.name, 'PXL_0001.png');
      assertEquals(moved.props.uid, 4101);
    });

    await t.step('PROPFIND lists one level, with sizes and ETags, and a 404 for what it does not keep', async () => {
      const res = await dav('PROPFIND', '/dav/home/anna/phone/', { headers: { depth: '1' }, body: PROPFIND_ETAG });
      assertEquals(res.status, 207);
      const xml = await res.text();
      assertStringIncludes(xml, '<D:href>/dav/home/anna/phone/</D:href>');
      assertStringIncludes(xml, '<D:href>/dav/home/anna/phone/PXL_0001.png</D:href>');
      assertStringIncludes(xml, `<D:getetag>"${sha}"</D:getetag>`);
      assertStringIncludes(xml, `<D:getcontentlength>${PNG_BYTES.length}</D:getcontentlength>`);
      assertStringIncludes(xml, '<colour xmlns="urn:example:x"/>');
      assertStringIncludes(xml, 'HTTP/1.1 404 Not Found');
      assertEquals(xml.includes('tacitpart'), false);

      const self = await dav('PROPFIND', '/dav/home/anna/phone/', { headers: { depth: '0' } });
      const selfXml = await self.text();
      assertEquals(selfXml.match(/<D:response>/g)?.length, 1);
      assertStringIncludes(selfXml, '<D:resourcetype><D:collection/></D:resourcetype>');

      const deep = await dav('PROPFIND', '/dav/home/anna/', { headers: { depth: 'infinity' } });
      const deepXml = await deep.text();
      assertStringIncludes(deepXml, '<D:href>/dav/home/anna/phone/</D:href>');
      assertEquals(deepXml.includes('PXL_0001.png'), false, 'one level, whatever the depth asked');

      const names = await dav('PROPFIND', '/dav/home/anna/phone/PXL_0001.png', { body: '<propfind xmlns="DAV:"><propname/></propfind>' });
      assertStringIncludes(await names.text(), '<D:getetag/>');
    });

    await t.step('an upload is frozen: a PUT over it is refused, and If-None-Match stops one', async () => {
      const over = await dav('PUT', '/dav/home/anna/phone/PXL_0001.png', { body: new Uint8Array([1, 2, 3]) });
      await over.body?.cancel();
      assertEquals(over.status, 403);
      const ifNone = await dav('PUT', '/dav/home/anna/phone/PXL_0001.png', { headers: { 'if-none-match': '*' }, body: PNG_BYTES });
      await ifNone.body?.cancel();
      assertEquals(ifNone.status, 412);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png')).attrs.size, PNG_BYTES.length);
    });

    await t.step('PUT needs its folder and a whole body, and never replaces a folder', async () => {
      for (
        const [path, init, status] of [
          ['/dav/home/anna/nowhere/a.txt', {}, 409],
          ['/dav/home/anna/phone', {}, 405],
          ['/dav/home/anna/phone/PXL_0001.png/inside.txt', {}, 409],
          ['/dav/home/anna/part.txt', { headers: { 'content-range': 'bytes 0-1/4' } }, 400],
        ] as const
      ) {
        const res = await dav('PUT', path, { ...init, body: 'text' });
        await res.body?.cancel();
        assertEquals(res.status, status, path);
      }
    });

    await t.step('a file that is not an upload of a picture is replaced, and keeps the time a sync app sends', async () => {
      const first = await dav('PUT', '/dav/home/anna/notes.txt', { body: 'first' });
      await first.body?.cancel();
      assertEquals(first.status, 201);
      const second = await dav('PUT', '/dav/home/anna/notes.txt', { headers: { 'x-oc-mtime': '1600000000' }, body: 'second' });
      await second.body?.cancel();
      assertEquals(second.status, 204);
      assertEquals(second.headers.get('x-oc-mtime'), 'accepted');

      const props = await dav('PROPFIND', '/dav/home/anna/notes.txt', { headers: { depth: '0' } });
      assertStringIncludes(await props.text(), `<D:getlastmodified>${new Date(1600000000 * 1000).toUTCString()}</D:getlastmodified>`);

      const get = await dav('GET', '/dav/home/anna/notes.txt');
      assertEquals(await get.text(), 'second');
      assertEquals(get.headers.get('x-content-type-options'), 'nosniff');
      const range = await dav('GET', '/dav/home/anna/notes.txt', { headers: { range: 'bytes=0-1' } });
      assertEquals(range.status, 206);
      assertEquals(await range.text(), 'se');

      const folder = await dav('GET', '/dav/home/anna/phone/');
      assertEquals(folder.status, 200);
      assertStringIncludes(await folder.text(), 'PROPFIND');
    });

    await t.step('a GET of an original is a download in the access log, via dav', async () => {
      const res = await dav('GET', '/dav/home/anna/phone/PXL_0001.png');
      assertEquals(new Uint8Array(await res.arrayBuffer()), PNG_BYTES);
      const downloads = await vfs.accessLog(ADMIN_ACCESS, { uid: 4101, events: ['download'], limit: 10 });
      assert(downloads.some((record) => record.via === 'dav' && record.path === '/home/anna/phone/PXL_0001.png'));
    });

    await t.step('MOVE refuses to write over an upload, a taken name with Overwrite F, itself and other namespaces', async () => {
      const copy = await dav('PUT', '/dav/home/anna/phone/copy.png.tacitpart', { body: PNG_BYTES });
      await copy.body?.cancel();
      for (
        const [destination, overwrite, status] of [
          ['/dav/home/anna/phone/PXL_0001.png', 'T', 403],
          ['/dav/home/anna/notes.txt', 'F', 412],
          ['/dav/home/anna/phone/copy.png.tacitpart', 'T', 403],
          ['/file/home/anna/phone/copy.png', 'T', 502],
          ['/dav/home/anna/missing/copy.png', 'T', 409],
        ] as const
      ) {
        const res = await dav('MOVE', '/dav/home/anna/phone/copy.png.tacitpart', { headers: { destination, overwrite } });
        await res.body?.cancel();
        assertEquals(res.status, status, destination);
      }
      const replaced = await dav('MOVE', '/dav/home/anna/phone/copy.png.tacitpart', { headers: { destination: '/dav/home/anna/notes.txt' } });
      await replaced.body?.cancel();
      assertEquals(replaced.status, 204);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/home/anna/notes.txt')).attrs.mimetype, 'image/png');
    });

    await t.step('an upload that breaks off part-way leaves no file behind', async () => {
      // A raw connection, so the request is surely under way, its file made, when it goes.
      const conn = await Deno.connect({ hostname: '127.0.0.1', port: httpPort });
      const head = `PUT /dav/home/anna/phone/cut.jpg HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nAuthorization: ${annaAuth}\r\nContent-Length: 1000000\r\n\r\n`;
      await conn.write(new TextEncoder().encode(head));
      await conn.write(new Uint8Array(64 * 1024));
      const waitFor = async (exists: boolean) => {
        for (let i = 0; i < 100; i++) {
          if (await vfs.exists(ADMIN_ACCESS, '/home/anna/phone/cut.jpg') === exists) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };
      assert(await waitFor(true), 'the upload made its file');
      conn.close();
      assert(await waitFor(false), 'the file went with the upload');
    });

    await t.step('DELETE moves into the trash, which is read-only here', async () => {
      const res = await dav('DELETE', '/dav/home/anna/notes.txt');
      await res.body?.cancel();
      assertEquals(res.status, 204);
      const entries = await vfs.children<{ origPath?: string }>(ADMIN_ACCESS, '/home/anna/.trash');
      const entry = entries.find((child) => child.node.attrs.origPath === '/home/anna/notes.txt');
      assert(entry, 'notes.txt is in the trash');
      const again = await dav('DELETE', '/dav/home/anna/notes.txt');
      await again.body?.cancel();
      assertEquals(again.status, 404);
      const inTrash = await dav('DELETE', `/dav/home/anna/.trash/${entry.name}`);
      await inTrash.body?.cancel();
      assertEquals(inTrash.status, 403);
    });

    await t.step('PROPPATCH sets a file time, all or nothing', async () => {
      const set = (props: string) =>
        dav('PROPPATCH', '/dav/home/anna/phone/PXL_0001.png', {
          body: `<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop>${props}</D:prop></D:set></D:propertyupdate>`,
        });
      const time = 'Sat, 05 Jul 2025 10:00:00 GMT';
      const ok = await set(`<Z:Win32LastModifiedTime>${time}</Z:Win32LastModifiedTime>`);
      assertEquals(ok.status, 207);
      assertStringIncludes(await ok.text(), 'HTTP/1.1 200 OK');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png')).attrs.writtenAt, new Date(time).toISOString());

      const mixed = await set('<Z:Win32LastModifiedTime>Sun, 06 Jul 2025 10:00:00 GMT</Z:Win32LastModifiedTime><D:displayname>other</D:displayname>');
      const xml = await mixed.text();
      assertStringIncludes(xml, 'HTTP/1.1 403 Forbidden');
      assertStringIncludes(xml, 'HTTP/1.1 424 Failed Dependency');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png')).attrs.writtenAt, new Date(time).toISOString());
    });

    await t.step('a listing reads past its first page, follows links, and leaves dangling ones out', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/home/anna', 'many', { props: { uid: 4101, gid: 4101, mode: 0o755 } });
      await vfs.createTree(
        ADMIN_ACCESS,
        '/home/anna/many',
        Array.from({ length: 600 }, (_, i) => ({ type: 'file', name: `f${String(i).padStart(4, '0')}.txt`, attrs: { size: 0 } })),
      );
      const many = await dav('PROPFIND', '/dav/home/anna/many/', { headers: { depth: '1' } });
      assertEquals((await many.text()).match(/<D:response>/g)?.length, 601);

      const link = (name: string, target: string) =>
        vfs.create(ADMIN_ACCESS, NODE_TYPE_SOFTLINK, '/home/anna', name, { props: { uid: 4101, gid: 4101, mode: 0o777, softlink: target } });
      await link('camera', '/home/anna/phone');
      await link('gone', '/home/anna/nothing-here');
      const home = await (await dav('PROPFIND', '/dav/home/anna/', { headers: { depth: '1' } })).text();
      assertStringIncludes(home, '<D:href>/dav/home/anna/camera/</D:href>');
      assertEquals(home.includes('/dav/home/anna/gone'), false);
    });

    await t.step('only a hash goes out as an ETag, and a stream typed as a page goes out as text', async () => {
      // `sha256` is an attr a member may set: written into an answer as it is, it would be markup.
      await vfs.update(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png', {
        attrs: { sha256: '"</D:getetag></D:prop></D:propstat></D:response><D:response><D:href>/dav/forged' },
      });
      const listing = await (await dav('PROPFIND', '/dav/home/anna/phone/', { headers: { depth: '1' } })).text();
      assertEquals(listing.includes('forged'), false);
      assertEquals(listing.match(/<D:response>/g)?.length, (listing.match(/<\/D:response>/g) ?? []).length);
      await vfs.update(ADMIN_ACCESS, '/home/anna/phone/PXL_0001.png', { attrs: { sha256: sha } });

      await vfs.create(ADMIN_ACCESS, 'stream', '/home/anna', 'live.html', { props: { uid: 4101, gid: 4101, mode: 0o644 }, attrs: { mimetype: 'text/html' } });
      const head = await dav('HEAD', '/dav/home/anna/live.html');
      await head.body?.cancel();
      assertEquals(head.headers.get('content-type'), 'text/plain; charset=utf-8');
      assertEquals(head.headers.get('x-content-type-options'), 'nosniff');
      assertStringIncludes(head.headers.get('content-security-policy') ?? '', 'sandbox');

      const many = `<propfind xmlns="DAV:"><prop>${'<getetag/>'.repeat(101)}</prop></propfind>`;
      const refused = await dav('PROPFIND', '/dav/home/anna/phone/', { body: many });
      await refused.body?.cancel();
      assertEquals(refused.status, 400);
    });

    await t.step("another account's folder is refused as the tree refuses it", async () => {
      const res = await dav('PROPFIND', '/dav/home/admin/', { headers: { depth: '1' } });
      await res.body?.cancel();
      assertEquals(res.status, 403);
    });

    await t.step('a password is checked once, and a change of it counts from the next request', async () => {
      assertEquals(await signIns(4101), 1);
      await Promise.all(Array.from({ length: 5 }, async () => {
        const res = await dav('PROPFIND', '/dav/home/anna/', { headers: { depth: '0' } });
        await res.body?.cancel();
        assertEquals(res.status, 207);
      }));
      assertEquals(await signIns(4101), 1);

      await setAccountPassword(vfs, ADMIN_ACCESS, join(USERS_PATH, 'anna'), 'harbour', PASSWORD_ENV);
      const stale = await dav('PROPFIND', '/dav/home/anna/', { headers: { depth: '0', 'x-forwarded-for': '192.0.2.21' } });
      await stale.body?.cancel();
      assertEquals(stale.status, 401);

      annaAuth = utf8Auth('anna', 'harbour');
      const together = await Promise.all(Array.from({ length: 4 }, () => dav('PROPFIND', '/dav/home/anna/', { headers: { depth: '0' } })));
      for (const res of together) {
        await res.body?.cancel();
        assertEquals(res.status, 207);
      }
      assertEquals(await signIns(4101), 2, 'requests that arrive together share one check');
    });

    await t.step('a disabled account is refused at its next request', async () => {
      await vfs.update(ADMIN_ACCESS, join(USERS_PATH, 'anna'), { attrs: { inactive: true } });
      const res = await dav('PROPFIND', '/dav/home/anna/', { headers: { depth: '0', 'x-forwarded-for': '192.0.2.22' } });
      await res.body?.cancel();
      assertEquals(res.status, 401);
      await vfs.update(ADMIN_ACCESS, join(USERS_PATH, 'anna'), { attrs: { inactive: false } });
    });

    await t.step('a failed sign-in is logged once a minute per address and reason', async () => {
      const wrong = utf8Auth('anna', 'not it');
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/dav/home/anna/`, { method: 'PROPFIND', headers: { authorization: wrong, 'x-forwarded-for': '192.0.2.30' } });
        await res.body?.cancel();
        assertEquals(res.status, 401);
      }
      const failed = await vfs.accessLog(ADMIN_ACCESS, { events: ['sign-in-failed'], from: '192.0.2.30', limit: 10 });
      assertEquals(failed.length, 1);
      assertEquals(failed[0].via, 'dav');
    });

    await t.step('a password sent as ISO-8859-1, as some clients do, signs in like UTF-8', async () => {
      for (const authorization of [utf8Auth('cecilia', 'blåbär'), latin1Auth('cecilia', 'blåbär')]) {
        const res = await fetch(`${baseUrl}/dav/home/cecilia/`, { method: 'PROPFIND', headers: { authorization, depth: '0' } });
        await res.body?.cancel();
        assertEquals(res.status, 207);
      }
    });

    await t.step('a path that names no node of the tree is a bad request, and /davx is not WebDAV', async () => {
      const res = await dav('PROPFIND', '/dav/home/anna/%2F..%2Fadmin');
      await res.body?.cancel();
      assertEquals(res.status, 400);
      const other = await fetch(`${baseUrl}/davx`, { method: 'PROPFIND' });
      await other.body?.cancel();
      assertEquals(other.status, 400);
    });

    await t.step('a PROPFIND body that is not XML this server takes is refused, and one too large', async () => {
      const doctype = await dav('PROPFIND', '/dav/home/anna/', {
        body: '<!DOCTYPE d [<!ENTITY a "aaaa">]><propfind xmlns="DAV:"><prop>&a;</prop></propfind>',
      });
      await doctype.body?.cancel();
      assertEquals(doctype.status, 400);
      const large = await dav('PROPFIND', '/dav/home/anna/', { body: `<propfind xmlns="DAV:">${' '.repeat(300 * 1024)}<allprop/></propfind>` });
      await large.body?.cancel();
      assertEquals(large.status, 413);
    });
  } finally {
    await harness.stop();
  }
});
