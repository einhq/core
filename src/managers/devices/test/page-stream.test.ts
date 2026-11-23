/**
 * What a page rendered for a screen needs of core: a page ticket that signs its browser in once,
 * read-only, as the access it was made with, and sends it to the page; and a live stream, or a set
 * of files made on demand, served to a device at an unguessable path, to anyone with it, until it
 * is ended or a stream's source has ended.
 */

import { assert, assertEquals, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import { storedAccess, verifyAccess } from '../../../lib/access/verify-access.ts';
import { SESSIONS_PATH } from '../../../lib/paths.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { SessionAttrs } from '../../../vfs/types/session.ts';
import { PAGE_TICKET_TTL_MS, PageTickets } from '../page-tickets.ts';
import type { LiveFormat } from '../types.ts';

const ACCESS = { uid: 2001, gid: 2001, gids: [2001, 100], sid: 'a-shell' };

Deno.test('a page ticket opens once, within its time', () => {
  const tickets = new PageTickets();
  const ticket = tickets.issue(ACCESS, '/dashboard-wall/Kitchen', 0);
  assertEquals(tickets.take(ticket, 1), { access: ACCESS, route: '/dashboard-wall/Kitchen' });
  assertEquals(tickets.take(ticket, 2), undefined);

  const late = tickets.issue(ACCESS, '/dashboard-wall/Kitchen', 0);
  assertEquals(tickets.take(late, PAGE_TICKET_TTL_MS), undefined);
});

const harness = new SystemTestHarness({ ssh: false });

const bytesOf = (text: string) => new TextEncoder().encode(text);

Deno.test({ name: 'a page signed in and streamed over HTTP', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();

  try {
    await t.step('a page is a path of this server', () => {
      assertThrows(() => devices.pageSignIn(ACCESS, 'https://elsewhere.test/'), Error, 'a path of this server');
      assertThrows(() => devices.pageSignIn(ACCESS, '//elsewhere.test/'), Error, 'a path of this server');
      assertThrows(() => devices.pageSignIn(ACCESS, '/\\elsewhere.test/'), Error, 'a path of this server');
      assertThrows(() => devices.pageSignIn(ACCESS, '/\t/elsewhere.test/'), Error, 'a path of this server');
      assertThrows(() => devices.pageSignIn(ACCESS, '/dashboard-wall/Kitchen\r\nSet-Cookie: x=1'), Error, 'a path of this server');
    });

    await t.step('a page is never shown as the administrator, nor as a member of its group', () => {
      assertThrows(() => devices.pageSignIn(ADMIN_ACCESS, '/dashboard-wall/Kitchen'), Error, 'never shown as the administrator');
      assertThrows(() => devices.pageSignIn({ ...ACCESS, gids: [...ACCESS.gids, ADMIN_ACCESS.gid] }, '/dashboard-wall/Kitchen'), Error, 'never shown as the administrator');
    });

    await t.step("a link that holds the administrator's uid or group reads only what anyone reads", () => {
      const asAdmin = { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, gids: [ADMIN_ACCESS.gid], link: { id: 'page', route: '/dashboard-wall/Kitchen' } };
      const inGroup = { ...ACCESS, gids: [...ACCESS.gids, ADMIN_ACCESS.gid], link: { id: 'page' } };
      assertEquals(verifyAccess(asAdmin, { uid: ADMIN_ACCESS.uid, gid: 0, mode: 0o600 }, 'r'), false);
      assertEquals(verifyAccess(inGroup, { uid: ADMIN_ACCESS.uid, gid: 0, mode: 0o640 }, 'r'), false);
      assertEquals(verifyAccess(inGroup, { uid: ACCESS.uid, gid: ACCESS.gid, mode: 0o600 }, 'r'), false);
      assertEquals(verifyAccess(asAdmin, { uid: ADMIN_ACCESS.uid, gid: 0, mode: 0o644 }, 'r'), true);
    });

    await t.step('the ticket signs a browser in once, read-only as its access, and sends it to the page', async () => {
      const path = devices.pageSignIn(ACCESS, '/dashboard-wall/Kitchen?x=1');
      assert(path.startsWith('/__page/'));
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      await res.body?.cancel();
      assertEquals(res.status, 303);
      assertEquals(res.headers.get('location'), '/dashboard-wall/Kitchen?x=1');
      const cookie = res.headers.get('set-cookie') ?? '';
      const [name, secret] = cookie.split(';')[0].split('=')[1].split('.');

      const session = await vfs.get<SessionAttrs>(ADMIN_ACCESS, join(SESSIONS_PATH, `session-${name}`));
      assertEquals(session.attrs.secret, secret);
      const access = storedAccess(session.attrs.access);
      assertEquals([access.uid, access.gids], [ACCESS.uid, ACCESS.gids]);
      assertEquals(access.link?.id, 'page');
      // The link names its page, which the Web UI keeps the browser on.
      assertEquals(access.link?.route, '/dashboard-wall/Kitchen?x=1');
      // It reads what its member reads, and does not write.
      assertEquals(verifyAccess(access, { uid: ACCESS.uid, gid: ACCESS.gid, mode: 0o600 }, 'r'), true);
      assertEquals(verifyAccess(access, { uid: ACCESS.uid, gid: ACCESS.gid, mode: 0o600 }, 'w'), false);
      assertEquals(verifyAccess(access, { uid: ADMIN_ACCESS.uid, gid: 0, mode: 0o600 }, 'r'), false);

      const again = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      await again.body?.cancel();
      assertEquals(again.status, 403);
    });

    await t.step('a live stream is served to whoever has its path, in both forms, from any page', async () => {
      const opened: LiveFormat[] = [];
      const served = devices.serveLive((format) => {
        opened.push(format);
        return Promise.resolve(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytesOf(`${format} bytes`));
              controller.close();
            },
          }),
        );
      });
      assert(/^\/live\/[0-9a-f]{64}$/.test(served.path));

      const mp4 = await fetch(`${baseUrl}${served.path}.mp4`);
      assertEquals(mp4.headers.get('content-type'), 'video/mp4');
      assertEquals(mp4.headers.get('access-control-allow-origin'), '*');
      assertEquals(await mp4.text(), 'mp4 bytes');
      const ts = await fetch(`${baseUrl}${served.path}.ts`, { headers: { 'getcontentFeatures.dlna.org': '1', 'transferMode.dlna.org': 'Streaming' } });
      assertEquals(ts.headers.get('content-type'), 'video/mp2t');
      assertEquals(ts.headers.get('contentfeatures.dlna.org'), 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000');
      assertEquals(ts.headers.get('transfermode.dlna.org'), 'Streaming');
      assertEquals(await ts.text(), 'ts bytes');

      const head = await fetch(`${baseUrl}${served.path}.mp4`, { method: 'HEAD' });
      assertEquals(head.status, 200);
      assertEquals(head.headers.get('content-type'), 'video/mp4');
      const preflight = await fetch(`${baseUrl}${served.path}.mp4`, { method: 'OPTIONS' });
      await preflight.body?.cancel();
      assertEquals(preflight.status, 204);
      assertEquals(opened, ['mp4', 'ts']);

      served.end();
      const ended = await fetch(`${baseUrl}${served.path}.mp4`);
      await ended.body?.cancel();
      assertEquals(ended.status, 404);
      const unknown = await fetch(`${baseUrl}/live/${'0'.repeat(64)}.mp4`);
      await unknown.body?.cancel();
      assertEquals(unknown.status, 404);
    });

    await t.step('a set of files is served by name, made when asked, until it is ended', async () => {
      const asked: string[] = [];
      const served = devices.serveFiles((name) => {
        asked.push(name);
        if (name === 'index.m3u8') return Promise.resolve({ body: bytesOf('#EXTM3U\n'), type: 'application/vnd.apple.mpegurl' });
        if (name === 'busy.ts') return Promise.reject(new Error('the media service is busy'));
        if (name !== '0.ts') return Promise.resolve(undefined);
        return Promise.resolve({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytesOf('segment'));
              controller.close();
            },
          }),
          type: 'video/mp2t',
        });
      });
      assert(/^\/live\/[0-9a-f]{64}$/.test(served.path));

      const playlist = await fetch(`${baseUrl}${served.path}/index.m3u8`);
      assertEquals(playlist.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assertEquals(playlist.headers.get('content-length'), '8');
      assertEquals(playlist.headers.get('access-control-allow-origin'), '*');
      assertEquals(await playlist.text(), '#EXTM3U\n');
      const segment = await fetch(`${baseUrl}${served.path}/0.ts`);
      assertEquals(segment.headers.get('content-type'), 'video/mp2t');
      assertEquals(await segment.text(), 'segment');
      const head = await fetch(`${baseUrl}${served.path}/0.ts`, { method: 'HEAD' });
      assertEquals(head.status, 200);
      for (const missing of ['1.ts', '..%2Fx', '.hidden']) {
        const res = await fetch(`${baseUrl}${served.path}/${missing}`);
        await res.body?.cancel();
        assertEquals(res.status, 404);
      }
      const busy = await fetch(`${baseUrl}${served.path}/busy.ts`);
      assertEquals(busy.status, 503);
      assertEquals(await busy.text(), 'the media service is busy');
      // A set is not a stream, and a stream's path is not a set's.
      const asStream = await fetch(`${baseUrl}${served.path}.mp4`);
      await asStream.body?.cancel();
      assertEquals(asStream.status, 404);
      assertEquals(asked, ['index.m3u8', '0.ts', '0.ts', '1.ts', 'busy.ts']);

      served.end();
      const ended = await fetch(`${baseUrl}${served.path}/index.m3u8`);
      await ended.body?.cancel();
      assertEquals(ended.status, 404);
    });

    await t.step('a stream whose source has ended is no longer served', async () => {
      let asked = 0;
      const served = devices.serveLive(() => {
        asked++;
        return Promise.resolve(undefined);
      });
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${baseUrl}${served.path}.ts`);
        await res.body?.cancel();
        assertEquals(res.status, 404);
      }
      assertEquals(asked, 1);
    });
  } finally {
    await harness.stop();
  }
});
