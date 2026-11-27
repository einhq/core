/**
 * Invitations: an account makes a token that opens named stream nodes, each to read or to write;
 * `GET /__invite/<token>` tells a page of any origin what it opens; its holder opens those nodes over
 * a WebSocket with `?invite=`, without a cookie and from another origin, and nothing else, not even
 * to learn whether another path exists. It reaches no more than its creator, and turning it off or
 * its expiry closes the sockets it opened. A socket node it opens is connected to, and its listener
 * is told the invitation the connection came through.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import type { SocketListener } from '../../../registries/socket/types.ts';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { Invitation, InvitationCreated, InvitationLink } from '../../../lib/api/invitation.ts';
import { NODE_SOCKET_CLOSE } from '../../../lib/api/node-socket.ts';
import { accessOfUid } from '../../../lib/auth/member-gids.ts';
import { INVITATIONS_PATH, USERS_PATH } from '../../../lib/paths.ts';
import { createTestContext } from '../../../testing/mod.ts';

/** Deno's `WebSocket`, which takes the handshake's headers; the DOM's declaration hides the option. */
const WebSocketWithHeaders = WebSocket as unknown as new (url: string, options: { headers: HeadersInit }) => WebSocket;

// Booted, so accounts and groups are made as on any instance, and `/var/invitations` at boot.
const testCtx = createTestContext({ boot: true });

const ELSEWHERE = 'https://elsewhere.example';
const HOUR_MS = 60 * 60 * 1000;

type Socket = { ws: WebSocket; messages: Uint8Array[]; opened: Promise<void>; closed: Promise<CloseEvent>; received(count: number): Promise<void> };

Deno.test({
  name: 'invitations',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs, baseUrl } = await testCtx.setup();
  const own = baseUrl.replace('localhost', '127.0.0.1');
  const wsBase = own.replace('http', 'ws');
  const admin = await testCtx.server.createShellClient();

  const open = (path: string, query: string, headers: Record<string, string> = {}): Socket => {
    const ws = new WebSocketWithHeaders(`${wsBase}/file${path}?${query}`, { headers });
    ws.binaryType = 'arraybuffer';
    const messages: Uint8Array[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    ws.addEventListener('message', (event) => {
      messages.push(new Uint8Array(event.data as ArrayBuffer));
      for (const waiter of waiters.filter((w) => messages.length >= w.count)) waiter.resolve();
    });
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve, { once: true }));
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      closed.then((event) => reject(new Error(`closed before it opened: ${event.code} ${event.reason}`)));
    });
    opened.catch(() => {});
    const received = (count: number) => messages.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }));
    return { ws, messages, opened, closed, received };
  };
  /** The close a socket that may not open ends with; one that opens is closed with 4999, which no refusal is. */
  const refused = async (path: string, query: string, headers: Record<string, string> = {}) => {
    const socket = open(path, query, headers);
    socket.opened.then(() => socket.ws.close(4999, 'it opened'), () => {});
    const { code, reason } = await socket.closed;
    return { code, reason };
  };
  const invite = (token: string) => fetch(`${own}/__invite/${token}`, { headers: { origin: ELSEWHERE } });

  let created: InvitationCreated | undefined;
  let annaCookie = '';

  try {
    await t.step('setup: anna in the club, bert outside it, two streams, a file and a stream only the administrator reads', async () => {
      for (
        const line of [
          'user-create anna && user-passwd anna --new-password secret1',
          'user-create bert && user-passwd bert --new-password secret1',
          'group-create club && group-add-member club anna',
          'mknode -p -t directory -m 0770 -g club /groups/club',
          'mknode -t stream -m 0660 -o anna -g club /groups/club/in /groups/club/out',
          'mknode -t stream -m 0600 /groups/club/private',
          'echo notes > /groups/club/notes.txt && chown anna:club /groups/club/notes.txt',
        ]
      ) {
        const result = await admin.exec(line, { json: false });
        assert(result.success, `${line}: ${result.error}`);
      }
      const uid = (await vfs.get<{ uid: number }>(ADMIN_ACCESS, `${USERS_PATH}/anna`)).attrs.uid;
      annaCookie = (await testCtx.harness.createHttpSession(await accessOfUid(vfs, uid))).cookie;
    });

    const anna = () => testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });

    await t.step('create opens stream nodes its creator may open in that mode, for a day unless told, and gives the token once', async () => {
      const client = await anna();
      created = await client.execJson<InvitationCreated>('invitation create --write /groups/club/in --read /groups/club/out');
      assertMatch(created.token, /^[A-Za-z0-9]{22}$/);
      assertMatch(created.id, /^[0-9a-f]{16}$/);
      assertEquals(created.link, `/__invite/${created.token}`);
      assertEquals(created.nodes, [{ path: '/groups/club/out', mode: 'r' }, { path: '/groups/club/in', mode: 'w' }]);
      assert(Math.abs(created.expiresAt - (Date.now() + 24 * HOUR_MS)) < 60_000);

      const record = await vfs.get<Record<string, unknown>>(ADMIN_ACCESS, `${INVITATIONS_PATH}/${created.id}`);
      assertEquals(JSON.stringify(record.attrs).includes(created.token), false, 'only the hash is kept');
      assertEquals(record.props.mode, 0o600);

      const file = await client.exec('invitation create --read /groups/club/notes.txt');
      assertStringIncludes(file.error ?? '', 'an invitation opens stream and socket nodes');
      const theirs = await client.exec('invitation create --read /groups/club/private');
      assertEquals(theirs.success, false, 'never more than its creator may');
      const far = await client.exec(`invitation create --read /groups/club/out --expires ${Date.now() + 100 * 24 * HOUR_MS}`);
      assertStringIncludes(far.error ?? '', 'at most 90 days');
    });

    await t.step('GET /__invite/<token> answers any origin what it opens; an unknown token is a 404 it can read too', async () => {
      const res = await invite(created!.token);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get('access-control-allow-origin'), '*');
      const body = await res.json() as InvitationLink;
      assertEquals(body.nodes, created!.nodes);
      assertEquals(body.expires, new Date(created!.expiresAt).toISOString());

      const unknown = await invite('AAAAAAAAAAAAAAAAAAAAAA');
      assertEquals(unknown.status, 404);
      assertEquals(unknown.headers.get('access-control-allow-origin'), '*');
      await unknown.body?.cancel();
    });

    await t.step('its holder writes and reads its nodes from another origin, without a cookie, a round trip with anna', async () => {
      const token = created!.token;
      const annaReads = open('/groups/club/in', 'mode=r', { cookie: annaCookie, origin: own });
      await annaReads.opened;
      const guestWrites = open('/groups/club/in', `mode=w&invite=${token}`, { origin: ELSEWHERE });
      await guestWrites.opened;
      const guestReads = open('/groups/club/out', `mode=r&invite=${token}`, { origin: ELSEWHERE, cookie: 'ein=whatever.ignored' });
      await guestReads.opened;
      const annaWrites = open('/groups/club/out', 'mode=w', { cookie: annaCookie, origin: own });
      await annaWrites.opened;

      guestWrites.ws.send(new Uint8Array([1, 2, 3]));
      await annaReads.received(1);
      assertEquals(annaReads.messages, [new Uint8Array([1, 2, 3])]);
      annaWrites.ws.send(new Uint8Array([4, 5]));
      await guestReads.received(1);
      assertEquals(guestReads.messages, [new Uint8Array([4, 5])]);

      for (const socket of [annaReads, guestWrites, guestReads, annaWrites]) socket.ws.close();
      await Promise.all([annaReads, guestWrites, guestReads, annaWrites].map((socket) => socket.closed));
    });

    await t.step('it opens nothing else: not its nodes in the other mode, not both ways, and the same answer for any other path', async () => {
      const token = created!.token;
      assertEquals((await refused('/groups/club/in', `mode=r&invite=${token}`)).code, NODE_SOCKET_CLOSE.forbidden);
      assertEquals((await refused('/groups/club/out', `mode=rw&invite=${token}`)).code, NODE_SOCKET_CLOSE.forbidden);
      const file = await refused('/groups/club/notes.txt', `mode=r&invite=${token}`);
      const missing = await refused('/groups/club/nothing', `mode=r&invite=${token}`);
      assertEquals([file.code, file.reason.replace('notes.txt', 'X')], [NODE_SOCKET_CLOSE.forbidden, missing.reason.replace('nothing', 'X')]);
      assertEquals((await refused('/groups/club/out', 'mode=r&invite=AAAAAAAAAAAAAAAAAAAAAA')).code, NODE_SOCKET_CLOSE.forbidden);
    });

    await t.step('it reaches no more than its creator does now', async () => {
      await admin.exec('chmod 0440 /groups/club/in');
      assertEquals((await refused('/groups/club/in', `mode=w&invite=${created!.token}`)).code, NODE_SOCKET_CLOSE.forbidden);
      await admin.exec('chmod 0660 /groups/club/in');
    });

    await t.step('list shows your own, with how often it was used; another account sees none of them', async () => {
      const mine = await (await anna()).execJson<Invitation[]>('invitation list');
      assertEquals(mine.map((item) => item.id), [created!.id]);
      assert(mine[0].opened >= 2);
      assertEquals(JSON.stringify(mine).includes(created!.token), false);
      const bert = await testCtx.server.createShellClient({ username: 'bert', password: 'secret1' });
      assertEquals(await bert.execJson<Invitation[]>('invitation list'), []);
      assertEquals((await bert.exec(`invitation remove ${created!.id}`)).success, false);
      assertEquals((await admin.execJson<Invitation[]>('invitation list')).length, 1);
    });

    await t.step('turning it off closes the sockets it opened, and it opens nothing more', async () => {
      const token = created!.token;
      const reader = open('/groups/club/out', `mode=r&invite=${token}`, { origin: ELSEWHERE });
      await reader.opened;
      await (await anna()).execJson(`invitation remove ${created!.id}`);
      const end = await reader.closed;
      assertEquals([end.code, end.reason], [NODE_SOCKET_CLOSE.gone, 'the invitation was turned off']);
      assertEquals((await invite(token)).status, 404);
      assertEquals((await refused('/groups/club/out', `mode=r&invite=${token}`)).code, NODE_SOCKET_CLOSE.forbidden);
    });

    await t.step('its expiry closes its sockets, and reap removes its record', async () => {
      const soon = await (await anna()).execJson<InvitationCreated>(`invitation create --read /groups/club/out --expires ${Date.now() + 1500}`);
      const reader = open('/groups/club/out', `mode=r&invite=${soon.token}`, { origin: ELSEWHERE });
      await reader.opened;
      const end = await reader.closed;
      assertEquals([end.code, end.reason], [NODE_SOCKET_CLOSE.gone, 'the invitation has expired']);
      assertEquals((await invite(soon.token)).status, 404);
      await admin.execJson('invitation reap');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${INVITATIONS_PATH}/${soon.id}`), false);
    });

    await t.step('a socket it opens is connected to, and the listener is told the invitation', async () => {
      assert((await admin.exec('mknode -t socket -m 0660 -o anna -g club /groups/club/table', { json: false })).success);
      const client = await anna();
      assertStringIncludes((await client.exec('invitation create --read /groups/club/table')).error ?? '', 'a socket is connected to');
      assertStringIncludes((await client.exec('invitation create --connect /groups/club/out')).error ?? '', 'a stream is read or written');
      const table = await client.execJson<InvitationCreated>('invitation create --connect /groups/club/table');
      assertEquals(table.nodes, [{ path: '/groups/club/table', mode: 'rw' }]);

      const uid = (await vfs.get<{ uid: number }>(ADMIN_ACCESS, `${USERS_PATH}/anna`)).attrs.uid;
      const listener = await vfs.open((await accessOfUid(vfs, uid))!, '/groups/club/table', { mode: 'r' }) as SocketListener;
      try {
        assertEquals((await refused('/groups/club/table', `mode=r&invite=${table.token}`)).code, NODE_SOCKET_CLOSE.forbidden);
        const guest = open('/groups/club/table', `mode=rw&invite=${table.token}`, { origin: ELSEWHERE });
        await guest.opened;
        guest.ws.send(new Uint8Array([1]));
        const connection = (await listener.accept())!;
        assertEquals(connection.peer, { uid, gid: connection.peer.gid, invitation: table.id });
        assertEquals(await connection.read(1024), new Uint8Array([1]));
        await connection.write(new Uint8Array([2]));
        await guest.received(1);
        assertEquals(guest.messages, [new Uint8Array([2])]);
        guest.ws.close();
        await guest.closed;
      } finally {
        await listener.close();
      }
    });
  } finally {
    await testCtx.teardown();
  }
});
