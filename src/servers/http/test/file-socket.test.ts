/**
 * A stream node held open over a WebSocket at its `/file/` path: one session's socket writes it,
 * another's reads each write back as one binary message, and the writer's close ends the reader's
 * socket. What may not open says why in the close frame: no mode, both ways, not a stream, no node,
 * no access, a writer already there; a ticket reads and never writes; and a page of another origin
 * may not use the session's cookie for it. A socket node's connection carries whole messages both
 * ways between the page and the node's listener, which is told who connected.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { isSocketListener } from '../../../registries/socket/types.ts';
import { NodeAccessDeniedError } from '../../../vfs/mod.ts';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_SOCKET_CLOSE } from '../../../lib/api/node-socket.ts';

/** Deno's `WebSocket`, which takes the handshake's headers; the DOM's declaration hides the option. */
const WebSocketWithHeaders = WebSocket as unknown as new (url: string, options: { headers: HeadersInit }) => WebSocket;

const harness = new SystemTestHarness({ ssh: false });

type Socket = {
  ws: WebSocket;
  /** The binary messages received so far. */
  messages: Uint8Array[];
  /** Settles once the socket is open, or rejects when it closes first. */
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
  /** Settles once `count` messages have come. */
  received(count: number): Promise<void>;
};

const ANNA = { uid: 4101, gid: 4101, gids: [4101, 4200] };
const BERTIL = { uid: 4102, gid: 4102, gids: [4102, 4200] };
const CECILIA = { uid: 4103, gid: 4103, gids: [4103] };

Deno.test({
  name: 'a stream node over a WebSocket',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs, devices } = await harness.start();
  const own = baseUrl.replace('localhost', '127.0.0.1');
  const host = new URL(own).host;
  const wsBase = own.replace('http', 'ws');
  const anna = (await harness.createHttpSession(ANNA)).cookie;
  const bertil = (await harness.createHttpSession(BERTIL)).cookie;
  const cecilia = (await harness.createHttpSession(CECILIA)).cookie;

  await vfs.ensure(ADMIN_ACCESS, 'directory', '/', 'groups', { props: { mode: 0o755 } });
  await vfs.create(ADMIN_ACCESS, 'directory', '/groups', 'club', { props: { uid: 0, gid: 4200, mode: 0o770 } });
  const stream = (name: string, mode: number) => vfs.create(ADMIN_ACCESS, 'stream', '/groups/club', name, { props: { uid: 4101, gid: 4200, mode } });
  await stream('board', 0o660);
  await stream('scores', 0o640);
  await vfs.create(ADMIN_ACCESS, 'file', '/groups/club', 'notes.txt', { props: { uid: 4101, gid: 4200, mode: 0o660 }, attrs: { size: 0 } });

  const open = (path: string, query: string, headers: Record<string, string> = {}): Socket => {
    const ws = new WebSocketWithHeaders(`${wsBase}/file${path}?${query}`, { headers: { origin: own, ...headers } });
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
  const refused = async (path: string, query: string, headers: Record<string, string> = {}): Promise<{ code: number; reason: string }> => {
    const socket = open(path, query, headers);
    socket.opened.then(() => socket.ws.close(4999, 'it opened'), () => {});
    const { code, reason } = await socket.closed;
    return { code, reason };
  };

  try {
    await t.step("one session writes, another reads each write back as one binary message; the writer's close ends the reader", async () => {
      const reader = open('/groups/club/board', 'mode=r', { cookie: bertil });
      await reader.opened;
      const writer = open('/groups/club/board', 'mode=w', { cookie: anna });
      await writer.opened;

      const big = crypto.getRandomValues(new Uint8Array(65536));
      const sent = [new Uint8Array([1, 2, 3]), big, new Uint8Array([0, 255])];
      for (const message of sent) writer.ws.send(message);
      await reader.received(3);
      assertEquals(reader.messages, sent);

      writer.ws.close();
      const end = await reader.closed;
      assertEquals([end.code, end.reason], [NODE_SOCKET_CLOSE.ended, 'the stream ended']);
      await writer.closed;
    });

    await t.step('a second writer is refused while the first holds the stream, and taken once it lets go', async () => {
      const first = open('/groups/club/board', 'mode=w', { cookie: anna });
      await first.opened;
      assertEquals((await refused('/groups/club/board', 'mode=w', { cookie: bertil })).code, NODE_SOCKET_CLOSE.conflict);
      first.ws.close();
      await first.closed;
      const next = open('/groups/club/board', 'mode=w', { cookie: bertil });
      await next.opened;
      next.ws.close();
      await next.closed;
    });

    await t.step('no mode, both ways, a file and no node are refused with why', async () => {
      assertEquals((await refused('/groups/club/board', '', { cookie: anna })).code, NODE_SOCKET_CLOSE.badRequest);
      const both = await refused('/groups/club/board', 'mode=rw', { cookie: anna });
      assertEquals([both.code, both.reason], [NODE_SOCKET_CLOSE.badRequest, 'a stream is read or written, not both: open one socket for each, or use a socket node']);
      assertEquals((await refused('/groups/club/notes.txt', 'mode=r', { cookie: anna })).code, NODE_SOCKET_CLOSE.badRequest);
      assertEquals((await refused('/groups/club/nothing', 'mode=r', { cookie: anna })).code, NODE_SOCKET_CLOSE.notFound);
    });

    await t.step("the node's own check decides: no group, no read; read alone, no write; the guest signs in first", async () => {
      assertEquals((await refused('/groups/club/board', 'mode=r', { cookie: cecilia })).code, NODE_SOCKET_CLOSE.forbidden);
      assertEquals((await refused('/groups/club/scores', 'mode=w', { cookie: bertil })).code, NODE_SOCKET_CLOSE.forbidden);
      const reader = open('/groups/club/scores', 'mode=r', { cookie: bertil });
      await reader.opened;
      reader.ws.close();
      await reader.closed;
      assertEquals((await refused('/groups/club/board', 'mode=r')).code, NODE_SOCKET_CLOSE.signIn);
    });

    await t.step('text, too large a message, or any message on a reader closes the socket', async () => {
      const writer = open('/groups/club/board', 'mode=w', { cookie: anna });
      await writer.opened;
      writer.ws.send('hello');
      assertEquals((await writer.closed).code, NODE_SOCKET_CLOSE.unsupported);

      const large = open('/groups/club/board', 'mode=w', { cookie: anna });
      await large.opened;
      large.ws.send(new Uint8Array(8 * 1024 * 1024 + 1));
      assertEquals((await large.closed).code, NODE_SOCKET_CLOSE.tooBig);

      const reader = open('/groups/club/board', 'mode=r', { cookie: bertil });
      await reader.opened;
      reader.ws.send(new Uint8Array([1]));
      assertEquals((await reader.closed).code, NODE_SOCKET_CLOSE.unsupported);
    });

    await t.step('a reader that falls more than its queue behind gets what it holds, then 4001', async () => {
      const slow = await rawReader(host, '/file/groups/club/board?mode=r', { cookie: bertil, origin: own });
      const writer = open('/groups/club/board', 'mode=w', { cookie: anna });
      await writer.opened;
      // More than the reader's queue, the socket's own buffer and the kernel's together.
      const message = new Uint8Array(65536);
      for (let i = 0; i < 512; i++) writer.ws.send(message);
      const { bytes, close } = await slow.drain();
      assertEquals(close, NODE_SOCKET_CLOSE.behind);
      assert(bytes > 0 && bytes < 32 * 1024 * 1024, `${bytes} bytes before the end`);
      writer.ws.close();
      await writer.closed;
    });

    await t.step('the node removed closes its writer with 4410 and ends its reader', async () => {
      await stream('gone', 0o660);
      const reader = open('/groups/club/gone', 'mode=r', { cookie: bertil });
      await reader.opened;
      const writer = open('/groups/club/gone', 'mode=w', { cookie: anna });
      await writer.opened;
      await vfs.unlink(ADMIN_ACCESS, '/groups/club/gone', '/groups/club');
      assertEquals((await writer.closed).code, NODE_SOCKET_CLOSE.gone);
      assertEquals((await reader.closed).code, NODE_SOCKET_CLOSE.ended);
    });

    await t.step('a ticket reads from any page without the cookie, and never writes', async () => {
      const ticket = await devices.fileTicket(BERTIL, '/groups/club/board');
      const reader = open('/groups/club/board', `mode=r&ticket=${ticket}`, { origin: 'http://elsewhere.example' });
      await reader.opened;
      const writer = open('/groups/club/board', 'mode=w', { cookie: anna });
      await writer.opened;
      writer.ws.send(new Uint8Array([7]));
      await reader.received(1);
      assertEquals(reader.messages, [new Uint8Array([7])]);
      writer.ws.close();
      assertEquals((await reader.closed).code, NODE_SOCKET_CLOSE.ended);
      await writer.closed;

      assertEquals((await refused('/groups/club/board', `mode=w&ticket=${ticket}`, { cookie: anna })).code, NODE_SOCKET_CLOSE.forbidden);
      assertEquals((await refused('/groups/club/scores', `mode=r&ticket=${ticket}`)).code, NODE_SOCKET_CLOSE.forbidden, 'a ticket is for its own file');
    });

    await t.step("a socket node's connection carries whole messages both ways between the page and the listener", async () => {
      await vfs.create(ADMIN_ACCESS, 'socket', '/groups/club', 'table', { props: { uid: 4101, gid: 4200, mode: 0o660 } });
      assertEquals((await refused('/groups/club/table', 'mode=rw', { cookie: bertil })).code, NODE_SOCKET_CLOSE.unavailable);
      await assertRejects(() => vfs.open(BERTIL, '/groups/club/table', { mode: 'r' }), NodeAccessDeniedError);
      const listener = await vfs.open(ANNA, '/groups/club/table', { mode: 'r' });
      assert(isSocketListener(listener));
      try {
        assertEquals((await refused('/groups/club/table', 'mode=r', { cookie: bertil })).code, NODE_SOCKET_CLOSE.badRequest);
        assertEquals((await refused('/groups/club/table', 'mode=rw', { cookie: cecilia })).code, NODE_SOCKET_CLOSE.forbidden);

        const client = open('/groups/club/table', 'mode=rw', { cookie: bertil });
        await client.opened;
        client.ws.send(new Uint8Array([1, 2, 3]));
        client.ws.send(new Uint8Array([4]));
        const connection = (await listener.accept())!;
        assertEquals(connection.peer.uid, BERTIL.uid);
        assertEquals(await connection.read(1024), new Uint8Array([1, 2, 3]));
        assertEquals(await connection.read(1024), new Uint8Array([4]));
        await connection.write(new Uint8Array([9, 8]));
        await connection.write(new Uint8Array([7]));
        await client.received(2);
        assertEquals(client.messages, [new Uint8Array([9, 8]), new Uint8Array([7])]);

        await connection.close();
        const end = await client.closed;
        assertEquals([end.code, end.reason], [NODE_SOCKET_CLOSE.ended, 'the connection ended']);

        const leaving = open('/groups/club/table', 'mode=rw', { cookie: bertil });
        await leaving.opened;
        const accepted = (await listener.accept())!;
        leaving.ws.close();
        assertEquals((await accepted.read(1024)).length, 0);
      } finally {
        await listener.close();
      }
    });

    await t.step('a page of another origin may not open a socket with the cookie', async () => {
      assertEquals(await handshake(host, '/file/groups/club/board?mode=r', { cookie: anna, origin: 'http://elsewhere.example' }), 403);
      assertEquals(await handshake(host, '/file/groups/club/board?mode=w', { cookie: anna, origin: `http://${new URL(own).hostname}:1984` }), 403);
      assertEquals(await handshake(host, '/file/groups/club/board?mode=r', { cookie: anna, origin: own }), 101);
    });
  } finally {
    await harness.stop();
  }
});

/**
 * A reader's socket that reads nothing until `drain`, which then reads everything to the close
 * frame: how many bytes of messages came, and the close code.
 */
async function rawReader(host: string, target: string, headers: Record<string, string>): Promise<{ drain(): Promise<{ bytes: number; close: number }> }> {
  const [hostname, port] = host.split(':');
  const conn = await Deno.connect({ hostname, port: Number(port) });
  const lines = [
    `GET ${target} HTTP/1.1`,
    `host: ${host}`,
    'upgrade: websocket',
    'connection: Upgrade',
    'sec-websocket-version: 13',
    `sec-websocket-key: ${btoa('0123456789abcdef')}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  await conn.write(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`));
  let buf = new Uint8Array(0);
  const more = async () => {
    const chunk = new Uint8Array(65536);
    const n = await conn.read(chunk);
    if (n === null) throw new Error('the connection ended before the close frame');
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
  };
  // The handshake's answer, before anything is held back.
  while (!new TextDecoder().decode(buf).includes('\r\n\r\n')) await more();
  const head = new TextDecoder().decode(buf).indexOf('\r\n\r\n') + 4;
  assertEquals(new TextDecoder().decode(buf.subarray(0, 12)), 'HTTP/1.1 101');
  buf = buf.subarray(head);
  return {
    async drain() {
      let bytes = 0;
      try {
        for (;;) {
          while (buf.length < 2) await more();
          const opcode = buf[0] & 0x0f;
          let length = buf[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            while (buf.length < 4) await more();
            length = (buf[2] << 8) | buf[3];
            offset = 4;
          } else if (length === 127) {
            while (buf.length < 10) await more();
            length = Number(new DataView(buf.buffer, buf.byteOffset + 2, 8).getBigUint64(0));
            offset = 10;
          }
          while (buf.length < offset + length) await more();
          const payload = buf.subarray(offset, offset + length);
          buf = buf.subarray(offset + length);
          if (opcode === 8) return { bytes, close: (payload[0] << 8) | payload[1] };
          bytes += length;
        }
      } finally {
        conn.close();
      }
    },
  };
}

/** The status a WebSocket handshake to `target` at `host` with `headers` is answered with. */
async function handshake(host: string, target: string, headers: Record<string, string>): Promise<number> {
  const [hostname, port] = host.split(':');
  const conn = await Deno.connect({ hostname, port: Number(port) });
  try {
    const lines = [
      `GET ${target} HTTP/1.1`,
      `host: ${host}`,
      'upgrade: websocket',
      'connection: Upgrade',
      'sec-websocket-version: 13',
      `sec-websocket-key: ${btoa('0123456789abcdef')}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ];
    await conn.write(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`));
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    const status = Number(new TextDecoder().decode(buf.subarray(0, n ?? 0)).split(' ')[1]);
    assert(status > 0);
    return status;
  } finally {
    conn.close();
  }
}
