/**
 * Static site vhost selection: Host header picks <root>/<host>, unknown hosts
 * (bare IPs, localhost, anything without its own directory) fall back to <root>/default.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import type { NodeVFS } from '../../../vfs/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

async function writeSite(vfs: NodeVFS, dir: string, body: string): Promise<void> {
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', dir);

  const encoded = new TextEncoder().encode(body);
  const attrs: FileAttrs = { name: 'index.html', mimetype: 'text/html', size: encoded.length };
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, `/${dir}`, 'index.html', { attrs });

  const fh = await vfs.open(ADMIN_ACCESS, `/${dir}/index.html`, { mode: 'w' });
  try {
    await fh.write(encoded);
  } finally {
    await fh.close();
  }
}

/**
 * Raw HTTP/1.1 request — `fetch` silently drops a caller-set Host header,
 * so the vhost paths can only be exercised over a socket.
 */
async function rawGet(port: number, host: string, path: string, cookie: string, extra: string[] = []): Promise<{ status: number; body: string; head: string }> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });

  try {
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Cookie: ${cookie}`,
      ...extra,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    await conn.write(new TextEncoder().encode(req));

    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);

    while (true) {
      const n = await conn.read(buf);

      if (n === null) {
        break;
      }

      chunks.push(buf.slice(0, n));
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const raw = new TextDecoder().decode(merged);
    const [head, ...rest] = raw.split('\r\n\r\n');

    return { status: Number.parseInt(head.split(' ')[1], 10), body: rest.join('\r\n\r\n'), head };
  } finally {
    conn.close();
  }
}

Deno.test({
  name: 'HTTP vhost selection',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs } = await harness.startPrimary();
  const { cookie } = await harness.createHttpSession();
  const port = Number.parseInt(new URL(baseUrl).port, 10);

  try {
    await writeSite(vfs, 'default', 'default site');
    await writeSite(vfs, 'example.com', 'example site');

    const get = (host: string, path = '/', extra: string[] = []) => rawGet(port, host, path, cookie, extra);

    await t.step('known host serves its own site', async () => {
      const res = await get('example.com');
      assertEquals(res.status, 200);
      assertEquals(res.body, 'example site');
    });

    await t.step('unknown host (bare IP) falls back to the default site', async () => {
      const res = await get('10.0.0.5:8080');
      assertEquals(res.status, 200);
      assertEquals(res.body, 'default site');
    });

    await t.step('localhost serves the default site', async () => {
      const res = await get('localhost:8080');
      assertEquals(res.status, 200);
      assertEquals(res.body, 'default site');
    });

    await t.step('malformed host falls back to the default site', async () => {
      const res = await get('[fe80::1]:8080');
      assertEquals(res.status, 200);
      assertEquals(res.body, 'default site');
    });

    await t.step('SPA fallback stays within the selected vhost', async () => {
      const res = await get('example.com', '/some/spa/route');
      assertEquals(res.status, 200);
      assertEquals(res.body, 'example site');
    });

    await t.step('the document names the origin it was reached at', async () => {
      await writeSite(vfs, 'origin.example', '<meta content="%EIN_ORIGIN%/og-image.jpg">');
      assertEquals((await get('origin.example')).body, '<meta content="http://origin.example/og-image.jpg">');
      assertEquals((await get('origin.example', '/a/route', ['X-Forwarded-Proto: https'])).body, '<meta content="https://origin.example/og-image.jpg">');
      assertEquals((await get('origin.example', '/index.html')).body, '<meta content="http://origin.example/og-image.jpg">');
    });

    await t.step('an icon may be cached', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/example.com', 'icons');
      const encoded = new TextEncoder().encode('<svg/>');
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, '/example.com/icons', 'x.svg', { attrs: { name: 'x.svg', mimetype: 'image/svg+xml', size: encoded.length } });
      const fh = await vfs.open(ADMIN_ACCESS, '/example.com/icons/x.svg', { mode: 'w' });
      try {
        await fh.write(encoded);
      } finally {
        await fh.close();
      }
      const res = await get('example.com', '/icons/x.svg');
      assertEquals(res.status, 200);
      assertEquals(/cache-control: public, max-age=86400/i.test(res.head), true, res.head);
      assertEquals(/cache-control/i.test((await get('example.com', '/')).head), false);
    });

    await t.step('a missing icon is a 404, not the SPA document', async () => {
      const res = await get('example.com', '/icons/tabler/outline/no-such-icon.svg');
      assertEquals(res.status, 404);
    });
  } finally {
    await harness.stop();
  }
});
