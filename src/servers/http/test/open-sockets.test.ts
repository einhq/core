/**
 * A stopping server closes its open WebSockets with 1001 (going away), a code the browser
 * accepts, rather than leaving them to `Deno.serve`, which sends the reserved 1005.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

/** Raw socket client: the close code a `WebSocket` reports is not always the one on the wire. */
async function openShellSocket(port: number): Promise<Deno.TcpConn> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  const request = [
    'GET /__shell HTTP/1.1',
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
  await conn.write(new TextEncoder().encode(request));

  const buf = new Uint8Array(4096);
  let head = '';
  while (!head.includes('\r\n\r\n')) {
    const n = await conn.read(buf);
    if (n === null) throw new Error('connection closed during the handshake');
    head += new TextDecoder().decode(buf.subarray(0, n));
  }
  assertEquals(head.split('\r\n')[0], 'HTTP/1.1 101 Switching Protocols');
  return conn;
}

/** The code of the first close frame the server sends, reading past any other frame. */
async function closeCode(conn: Deno.TcpConn): Promise<number | undefined> {
  const bytes: number[] = [];
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(buf).catch(() => null);
    if (n === null) break;
    bytes.push(...buf.subarray(0, n));
  }
  // Server frames are unmasked; the payloads here stay under 126 bytes.
  for (let at = 0; at + 1 < bytes.length; at += 2 + (bytes[at + 1] & 0x7f)) {
    if ((bytes[at] & 0x0f) === 0x8) return (bytes[at + 2] << 8) | bytes[at + 3];
  }
  return undefined;
}

Deno.test({
  name: 'a stopping http server closes its WebSockets with 1001',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const instance = await harness.start();
  const conn = await openShellSocket(instance.httpPort);
  try {
    const code = closeCode(conn);
    await harness.stop();
    assertEquals(await code, 1001);
  } finally {
    try {
      conn.close();
    } catch { /* closed already */ }
  }
});
