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
import { BOOT_ID } from '../../../lib/boot-id/mod.ts';
import { SESSIONS_PATH } from '../../../lib/paths.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { SESSION_ENDED_CLOSE_CODE } from '../../../servers/http/ws/api-shell-handler.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
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

Deno.test("a page ticket's session is held until its page ends", () => {
  const tickets = new PageTickets();
  const ticket = tickets.issue(ACCESS, '/dashboard-wall/Kitchen', 0);
  assertEquals(tickets.opened(ticket, '/var/sessions/session-a'), false, 'a ticket not taken holds no session');
  tickets.take(ticket, 1);
  assertEquals(tickets.opened(ticket, '/var/sessions/session-a'), true);
  assertEquals(tickets.end(ticket), '/var/sessions/session-a');
  assertEquals(tickets.end(ticket), undefined);

  // A page that ends while its browser signs in: the session opened after it is refused.
  const racing = tickets.issue(ACCESS, '/dashboard-wall/Kitchen', 0);
  tickets.take(racing, 1);
  assertEquals(tickets.end(racing), undefined);
  assertEquals(tickets.opened(racing, '/var/sessions/session-b'), false);

  // A page that ends before its browser signs in: the ticket no longer opens.
  const unused = tickets.issue(ACCESS, '/dashboard-wall/Kitchen', 0);
  tickets.end(unused);
  assertEquals(tickets.take(unused, 1), undefined);
});

const harness = new SystemTestHarness({ ssh: false });

/**
 * A shell socket opened with `cookie`, as the page's browser opens one (`WebSocket` sends no
 * cookie of a test's): the close code the server ends it with, once it does.
 */
async function openShell(baseUrl: string, cookie: string): Promise<{ closed: Promise<number> }> {
  const { hostname, port, host } = new URL(baseUrl);
  const conn = await Deno.connect({ hostname, port: Number(port) });
  const lines = [
    'GET /__shell HTTP/1.1',
    `host: ${host}`,
    'upgrade: websocket',
    'connection: Upgrade',
    'sec-websocket-version: 13',
    `sec-websocket-key: ${btoa('0123456789abcdef')}`,
    `cookie: ${cookie}`,
  ];
  await conn.write(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`));
  let bytes = new Uint8Array(0);
  const more = async () => {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new Error('the socket closed without a close frame');
    bytes = new Uint8Array([...bytes, ...buf.subarray(0, n)]);
  };
  const end = () => new TextDecoder().decode(bytes).indexOf('\r\n\r\n');
  while (end() < 0) await more();
  assertEquals(new TextDecoder().decode(bytes).split(' ')[1], '101');
  bytes = bytes.subarray(end() + 4);
  /** The server's next frame, unmasked: its opcode and payload. */
  const frame = async (): Promise<{ opcode: number; payload: Uint8Array }> => {
    while (bytes.length < 2) await more();
    let length = bytes[1] & 0x7f;
    let at = 2;
    if (length === 126) {
      while (bytes.length < 4) await more();
      length = (bytes[2] << 8) | bytes[3];
      at = 4;
    } else if (length === 127) {
      while (bytes.length < 10) await more();
      length = Number(new DataView(bytes.buffer, bytes.byteOffset + 2, 8).getBigUint64(0));
      at = 10;
    }
    while (bytes.length < at + length) await more();
    const read = { opcode: bytes[0] & 0x0f, payload: bytes.slice(at, at + length) };
    bytes = bytes.subarray(at + length);
    return read;
  };
  // A command answered: the shell has opened, and so watches its session.
  const request = new TextEncoder().encode(JSON.stringify({ type: 'exec', command: 'true', id: 'ready' }));
  const mask = new Uint8Array(4);
  await conn.write(new Uint8Array([0x81, 0x80 | request.length, ...mask, ...request]));
  for (;;) {
    const { opcode, payload } = await frame();
    if (opcode === 0x1 && new TextDecoder().decode(payload).includes('"ready"')) break;
  }
  const closed = (async () => {
    try {
      for (;;) {
        const { opcode, payload } = await frame();
        if (opcode === 0x8) return (payload[0] << 8) | payload[1];
      }
    } finally {
      conn.close();
    }
  })();
  return { closed };
}

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
      await devices.endPageSignIn(path);
    });

    /** A page signed in over HTTP: its sign-in path, the browser's cookie and the session's path. */
    const signIn = async () => {
      const path = devices.pageSignIn(ACCESS, '/dashboard-wall/Kitchen');
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      await res.body?.cancel();
      assertEquals(res.status, 303);
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
      return { path, cookie, session: join(SESSIONS_PATH, `session-${cookie.split('=')[1].split('.')[0]}`) };
    };
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, '/tmp', 'page-probe.txt', { props: { uid: ACCESS.uid, gid: ACCESS.gid, mode: 0o600 }, attrs: { mimetype: 'text/plain' } });
    const probeFile = await vfs.open(ADMIN_ACCESS, '/tmp/page-probe.txt', { mode: 'w' });
    await probeFile.write(bytesOf('probe'));
    await probeFile.close();
    /** What `/file` answers the browser with `cookie`: 200 while it reads as the member, 401 as the guest. */
    const probe = async (cookie: string) => {
      const res = await fetch(`${baseUrl}/file/tmp/page-probe.txt`, { headers: { cookie } });
      await res.body?.cancel();
      return res.status;
    };

    await t.step("the page's end removes its session, which its cookie no longer opens", async () => {
      const { path, cookie, session } = await signIn();
      assertEquals((await vfs.get<SessionAttrs>(ADMIN_ACCESS, session)).attrs.endsWithBoot, BOOT_ID);
      assertEquals(await probe(cookie), 200);

      // The page's shell socket, which took the session's access when it opened.
      const { closed } = await openShell(baseUrl, cookie);

      await devices.endPageSignIn(path);
      assertEquals(await vfs.exists(ADMIN_ACCESS, session), false);
      assertEquals(await probe(cookie), 401);
      assertEquals(await closed, SESSION_ENDED_CLOSE_CODE);
      // Ending it again finds nothing left to end.
      await devices.endPageSignIn(path);
    });

    await t.step('a page that ended before its browser came signs nobody in', async () => {
      const path = devices.pageSignIn(ACCESS, '/dashboard-wall/Kitchen');
      await devices.endPageSignIn(path);
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      await res.body?.cancel();
      assertEquals(res.status, 403);
      assertEquals(res.headers.get('set-cookie'), null);
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before);
    });

    await t.step('a page session from a process that has ended is refused', async () => {
      const { path, cookie, session } = await signIn();
      await vfs.update<SessionAttrs>(ADMIN_ACCESS, session, { attrs: { endsWithBoot: 'OTHERBOOT' } });
      assertEquals(await probe(cookie), 401);
      await devices.endPageSignIn(path);
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
