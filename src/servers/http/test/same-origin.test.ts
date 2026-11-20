/**
 * Pages of other origins that the browser hands the `SameSite=Lax` cookie to — another port of
 * the same host, a sibling host name — may neither open the shell nor write as the session.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { isCrossOrigin } from '../same-origin.ts';

Deno.test('isCrossOrigin', async (t) => {
  const cross = (headers: Record<string, string>) => isCrossOrigin(new Headers(headers));

  await t.step('the same host and port is the same origin, whatever the scheme', () => {
    assertEquals(cross({ host: 'ein.local:8080', origin: 'http://ein.local:8080' }), false);
    assertEquals(cross({ host: 'ein.example', origin: 'https://ein.example' }), false);
    assertEquals(cross({ host: 'EIN.example:443', origin: 'https://ein.example' }), false, 'a default port and case do not count');
  });

  await t.step('another port, a sibling host or a sandboxed page is another origin', () => {
    assertEquals(cross({ host: 'ein.local:8080', origin: 'http://ein.local:1984' }), true);
    assertEquals(cross({ host: 'ein.example', origin: 'https://other.example' }), true);
    assertEquals(cross({ host: 'ein.example', origin: 'https://evil.ein.example' }), true);
    assertEquals(cross({ host: 'ein.local:8080', origin: 'null' }), true);
  });

  await t.step('Sec-Fetch-Site decides when the browser sends it', () => {
    assertEquals(cross({ host: 'internal:8080', origin: 'https://ein.example', 'sec-fetch-site': 'same-origin' }), false);
    assertEquals(cross({ host: 'ein.example', 'sec-fetch-site': 'none' }), false);
    assertEquals(cross({ host: 'ein.example', origin: 'https://ein.example', 'sec-fetch-site': 'same-site' }), true);
  });

  await t.step('a request without Origin is not a browser page of another origin', () => {
    assertEquals(cross({ host: 'ein.local:8080' }), false);
  });
});

const harness = new SystemTestHarness({ ssh: false });

/** The status a WebSocket handshake to `/__shell` at `host` with `headers` is answered with. */
async function handshake(host: string, headers: Record<string, string>): Promise<number> {
  const [hostname, port] = host.split(':');
  const conn = await Deno.connect({ hostname, port: Number(port) });
  try {
    const lines = [
      'GET /__shell HTTP/1.1',
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
    return Number(new TextDecoder().decode(buf.subarray(0, n ?? 0)).split(' ')[1]);
  } finally {
    conn.close();
  }
}

Deno.test({
  name: 'requests from pages of other origins',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl } = await harness.start();
  const { cookie } = await harness.createHttpSession();
  const own = baseUrl.replace('localhost', '127.0.0.1');
  const host = new URL(own).host;
  const other = `http://${new URL(own).hostname}:1984`;

  try {
    await t.step('a write with the cookie from another origin is refused, from its own origin or no page made', async () => {
      const put = (headers: Record<string, string>) => fetch(`${own}/file/tmp/origin.txt`, { method: 'PUT', headers: { cookie, ...headers }, body: 'x' });

      const refused = await put({ origin: other });
      assertEquals(refused.status, 403);
      await refused.body?.cancel();

      for (const headers of [{ origin: `http://${host}` }, {}] as Record<string, string>[]) {
        const res = await put(headers);
        assertEquals(res.status < 300, true, `${JSON.stringify(headers)}: ${res.status}`);
        await res.body?.cancel();
      }
    });

    await t.step('a read with the cookie from another origin is answered', async () => {
      const res = await fetch(`${own}/file/tmp/origin.txt`, { headers: { cookie, origin: other } });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step('the shell opens only from its own origin', async () => {
      assertEquals(await handshake(host, { cookie, origin: other }), 403);
      assertEquals(await handshake(host, { cookie, origin: `http://${host}` }), 101);
      assertEquals(await handshake(host, { origin: other }), 101, 'without the cookie it is a stranger, the guest');
    });
  } finally {
    await harness.stop();
  }
});
