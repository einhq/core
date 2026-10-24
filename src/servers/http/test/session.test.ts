/**
 * HTTP session handling: cookie validation, expiry, lastActivity and
 * guest session issuance.
 */

import { PIPELINES_PATH, SESSIONS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../vfs/types/session.ts';
import { SESSION_ACTIVITY_FLOOR_MS } from '../session.ts';

const harness = new SystemTestHarness({ ssh: false });

/**
 * What a browser sends when it navigates. `Sec-Fetch-*` is deliberately absent:
 * browsers attach it only to potentially trustworthy origins, so over plain
 * HTTP the `Accept` preference is all a real navigation carries.
 */
const NAVIGATION = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

Deno.test({
  name: 'HTTP sessions',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs } = await harness.startPrimary();
  const { cookie, sessionPath } = await harness.createHttpSession();

  // A file to probe with
  const shell = await harness.createShellClient();
  await shell.exec('mkfile /tmp/probe.txt');
  await shell.exec('echo "probe" > /tmp/probe.txt');
  shell.close();

  try {
    const lastActivity = async () => (await vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath)).attrs.lastActivity;
    const probe = async () => {
      const res = await fetch(`${baseUrl}/file/tmp/probe.txt`, { headers: { cookie } });
      assertEquals(res.status, 200);
      await res.arrayBuffer();
      return res;
    };

    await t.step('valid cookie reuses the session and bumps an idle lastActivity', async () => {
      const before = Date.now() - SESSION_ACTIVITY_FLOOR_MS - 1000;
      await vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, { attrs: { lastActivity: before } });

      const res = await probe();

      // No new cookie issued
      assertEquals(res.headers.get('set-cookie'), null);
      assertEquals(await lastActivity() > before, true);
    });

    await t.step('a session active within the floor is not written again', async () => {
      const before = Date.now() - 1000;
      await vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, { attrs: { lastActivity: before } });

      await probe();

      assertEquals(await lastActivity(), before);
    });

    await t.step('wrong secret is rejected and falls back to guest', async () => {
      const badCookie = cookie.replace(/=(.*)\.(.*)$/, '=$1.wrongsecret');
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const res = await fetch(`${baseUrl}/file/tmp/probe.txt`, { headers: { cookie: badCookie } });
      // Answered as the guest, whom a closed archive refuses `/file`.
      assertEquals(res.status, 401);
      await res.arrayBuffer();

      // An asset fetch answers as a guest rather than minting a session the
      // client may never present again.
      assertEquals(res.headers.get('set-cookie'), null);
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before);

      // The original session is untouched
      const original = await vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);
      assertEquals(typeof original.attrs.secret, 'string');
    });

    await t.step('expired session is rejected', async () => {
      const { cookie: expiredCookie, sessionPath: expiredPath } = await harness.createHttpSession();
      await vfs.update<SessionAttrs>(ADMIN_ACCESS, expiredPath, { attrs: { expired: true } });

      const res = await fetch(`${baseUrl}/file/tmp/probe.txt`, { headers: { cookie: expiredCookie } });
      // Answered as the guest, whom a closed archive refuses `/file`.
      assertEquals(res.status, 401);
      await res.arrayBuffer();
      assertEquals(res.headers.get('set-cookie'), null);
    });

    await t.step('a navigation to the SPA document issues a cookie', async () => {
      // The document has to exist: a 404 is thrown before the response is built,
      // so responseHeaders (and the cookie) never reach the client.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'default');
      const body = new TextEncoder().encode('<html></html>');
      await vfs.create<FileAttrs>(ADMIN_ACCESS, NODE_TYPE_FILE, '/default', 'index.html', {
        attrs: { name: 'index.html', mimetype: 'text/html', size: body.length },
      });
      const fh = await vfs.open(ADMIN_ACCESS, '/default/index.html', { mode: 'w' });
      try {
        await fh.write(body);
      } finally {
        await fh.close();
      }

      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const res = await fetch(`${baseUrl}/`, { headers: NAVIGATION });
      await res.arrayBuffer();

      const setCookie = res.headers.get('set-cookie') ?? '';
      assertEquals(setCookie.includes('ein-test='), true, 'document did not issue a session cookie');
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before + 1);
    });

    await t.step('the cookie is scoped to the whole site, not to the URL that minted it', async () => {
      // Without an explicit Path the browser derives one from the request URI,
      // so an entry on a nested route would scope the cookie to that subtree and
      // the shell WebSocket at /__shell would never see it.
      for (const path of ['/', '/timeline', `${PIPELINES_PATH}/media-describe/01ABC`]) {
        const res = await fetch(`${baseUrl}${path}`, { headers: NAVIGATION });
        await res.arrayBuffer();

        const setCookie = res.headers.get('set-cookie') ?? '';
        assertEquals(setCookie.includes('ein-test='), true, `${path} issued no cookie`);
        assertEquals(setCookie.includes('Path=/;') || setCookie.endsWith('Path=/'), true, `${path} scoped the cookie to ${setCookie}`);
      }
    });

    await t.step('the document re-stamps the cookie of a session it already knows', async () => {
      // Every navigation re-stamps the cookie, so a session in daily use does
      // not expire one cookie lifetime after it was first minted.
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const res = await fetch(`${baseUrl}/`, { headers: { ...NAVIGATION, cookie } });
      await res.arrayBuffer();

      const setCookie = res.headers.get('set-cookie') ?? '';
      assertEquals(setCookie.includes(cookie.split('=')[1].split('.')[0]), true, 'document did not re-issue the presented cookie');
      assertEquals(setCookie.includes('Max-Age=86400'), true, setCookie);
      // Re-stamping must not mint anything.
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before);
    });

    await t.step('the lifetimes follow the settings from the next navigation', async () => {
      const admin = await harness.createShellClient();
      try {
        await admin.exec('config set CFG_SESSION_MAX_AGE_SEC 3600 && config set CFG_SESSION_EXPIRES_SEC 600');

        const known = await fetch(`${baseUrl}/`, { headers: { ...NAVIGATION, cookie } });
        await known.arrayBuffer();
        assertEquals((known.headers.get('set-cookie') ?? '').includes('Max-Age=3600'), true, known.headers.get('set-cookie') ?? '');

        const fresh = await fetch(`${baseUrl}/`, { headers: NAVIGATION });
        await fresh.arrayBuffer();
        const setCookie = fresh.headers.get('set-cookie') ?? '';
        assertEquals(setCookie.includes('Max-Age=3600'), true, setCookie);
        const name = setCookie.match(/ein-test=([^.]+)\./)![1];
        const session = await vfs.get<SessionAttrs>(ADMIN_ACCESS, `${SESSIONS_PATH}/session-${name}`);
        assertEquals(session.attrs.expiresSec, 600);
      } finally {
        await admin.exec('config unset CFG_SESSION_MAX_AGE_SEC && config unset CFG_SESSION_EXPIRES_SEC');
        admin.close();
      }
    });

    await t.step('the cookie is Secure only when a proxy reports HTTPS', async () => {
      const cases: [Record<string, string>, boolean][] = [
        [{}, false],
        [{ 'x-forwarded-proto': 'http' }, false],
        [{ 'x-forwarded-proto': 'https' }, true],
        [{ 'x-forwarded-proto': 'https, http' }, true],
        [{ forwarded: 'for=192.0.2.1;proto=https;host=ein.example' }, true],
        [{ forwarded: 'for=192.0.2.1;proto=http' }, false],
      ];
      for (const [headers, secure] of cases) {
        const res = await fetch(`${baseUrl}/`, { headers: { ...NAVIGATION, ...headers } });
        await res.arrayBuffer();

        const setCookie = res.headers.get('set-cookie') ?? '';
        assertEquals(setCookie.includes('ein-test='), true, JSON.stringify(headers));
        assertEquals(/; Secure(;|$)/.test(setCookie), secure, `${JSON.stringify(headers)}: ${setCookie}`);
      }
    });

    await t.step('a navigation to a client-side route issues a cookie', async () => {
      // No such path in the vhost, so this is the SPA fallback — and it is the
      // case the fallback exists for: a browser opening /timeline directly.
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const res = await fetch(`${baseUrl}/timeline`, { headers: NAVIGATION });
      assertEquals(res.status, 200);
      assertEquals(await res.text(), '<html></html>');

      assertEquals((res.headers.get('set-cookie') ?? '').includes('ein-test='), true);
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before + 1);
    });

    await t.step('the SPA fallback mints nothing for a non-navigation', async () => {
      // Stale bookmarks, missing assets and scanners all land on the fallback,
      // and none of them will ever present the cookie back.
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const probes: { path: string; headers: Record<string, string> }[] = [
        { path: '/wp-login.php', headers: {} },
        { path: '/assets/gone.js', headers: { accept: '*/*' } },
        { path: '/img/gone.png', headers: { accept: 'image/avif,image/webp,*/*;q=0.8' } },
        // Sec-Fetch-Mode is authoritative when the browser sends it: an in-page
        // fetch() for a missing endpoint says text/html and is still no navigation.
        { path: '/api/gone', headers: { accept: 'text/html', 'sec-fetch-mode': 'cors' } },
      ];

      for (const probe of probes) {
        const res = await fetch(`${baseUrl}${probe.path}`, { headers: probe.headers });
        assertEquals(res.status, 200, probe.path);
        // Still the SPA document, just without a session behind it
        assertEquals(await res.text(), '<html></html>', probe.path);
        assertEquals(res.headers.get('set-cookie'), null, probe.path);
      }

      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before);
    });

    await t.step('Sec-Fetch-Mode: navigate issues a cookie on its own', async () => {
      // A trustworthy origin sends the header and an Accept the fallback would
      // reject on its own; the header decides.
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const res = await fetch(`${baseUrl}/gone`, { headers: { accept: '*/*', 'sec-fetch-mode': 'navigate' } });
      await res.arrayBuffer();

      assertEquals((res.headers.get('set-cookie') ?? '').includes('ein-test='), true);
      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before + 1);
    });

    await t.step('HEAD serves the SPA document headers without a body', async () => {
      const res = await fetch(`${baseUrl}/`, { method: 'HEAD', headers: { cookie } });

      assertEquals(res.status, 200);
      assertEquals(res.headers.get('content-type'), 'text/html');
      assertEquals(res.headers.get('content-length'), '13');
      assertEquals((await res.arrayBuffer()).byteLength, 0);
    });

    await t.step('anonymous asset and write requests create nothing', async () => {
      const before = (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      for (let i = 0; i < 5; i++) {
        await (await fetch(`${baseUrl}/file/tmp/probe.txt`)).arrayBuffer();
      }
      const put = await fetch(`${baseUrl}/file/tmp/anon.txt`, { method: 'PUT', body: 'x' });
      await put.arrayBuffer();

      assertEquals((await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length, before);
    });

    await t.step('a WebSocket client without a cookie leaves no session behind', async () => {
      // The 101 upgrade cannot carry Set-Cookie, so this session is reachable
      // only while the socket is: it is stamped and dropped on close.
      const countSessions = async () => (await vfs.children(ADMIN_ACCESS, SESSIONS_PATH)).length;

      const before = await countSessions();

      const client = await harness.createShellClient();
      assertEquals((await client.exec('pwd')).success, true);
      // Its own session must survive while the socket is open.
      assertEquals(await countSessions() > before, true);
      client.close();

      for (let i = 0; i < 40 && await countSessions() > before; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(await countSessions(), before);
    });

    await t.step('a cookie-backed session survives the socket that used it', async () => {
      const { sessionPath: keepPath } = await harness.createHttpSession();

      // Same shape as above, but the session already existed and is cookie-backed,
      // so it carries no boot stamp and must not be collected.
      const client = await harness.createShellClient();
      assertEquals((await client.exec('pwd')).success, true);
      client.close();

      await new Promise((r) => setTimeout(r, 200));
      assertEquals(await vfs.exists(ADMIN_ACCESS, keepPath), true);
    });

    await t.step('only a session node is a session, and what it holds is never the admin flag', async () => {
      const admin = await harness.createShellClient();
      await admin.exec('mkfile /tmp/admin-only.txt && echo "secret" > /tmp/admin-only.txt && chmod 0600 /tmp/admin-only.txt');
      admin.close();
      const fetchAs = async (cookieHeader: string) => {
        const res = await fetch(`${baseUrl}/file/tmp/admin-only.txt`, { headers: { cookie: cookieHeader } });
        await res.arrayBuffer();
        return res.status;
      };
      assertEquals(await fetchAs(cookie), 200);

      // A directory where a session would be, with a secret and the administrator's access.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, SESSIONS_PATH, 'session-forged', {
        attrs: { secret: 'known', access: { uid: 0, gid: 0, gids: [0] } },
      });
      assertEquals(await fetchAs('ein-test=forged.known') === 200, false);

      // A real session whose stored access carries the flag acts as its uid alone.
      await vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, SESSIONS_PATH, 'session-flagged', {
        props: { mode: 0o700 },
        attrs: {
          secret: 'known',
          access: { uid: 3000, gid: 3000, gids: [3000], admin: true },
          env: {},
          createdAt: Date.now(),
          lastActivity: Date.now(),
          expiresSec: 60 * 60,
        },
      });
      assertEquals(await fetchAs('ein-test=flagged.known') === 200, false);
    });

    await t.step('malformed cookie falls back to guest access', async () => {
      const res = await fetch(`${baseUrl}/file/tmp/probe.txt`, {
        headers: { cookie: 'ein-test=not-a-valid-value' },
      });
      // Answered as the guest, whom a closed archive refuses `/file`.
      assertEquals(res.status, 401);
      await res.arrayBuffer();
      assertEquals(res.headers.get('set-cookie'), null);
    });
  } finally {
    await harness.stop();
  }
});
