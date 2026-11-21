/**
 * `curl` against an HTTP server on a listener-assigned port.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { type ShellClient, SystemTestHarness } from '../../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

function text(result: { data: unknown; error?: string }): string {
  return `${typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')}${result.error ?? ''}`;
}

Deno.test({
  name: 'curl',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/hello.txt') return new Response('hello from the web\n');
    if (path === '/files/sail%20boat.png') return new Response(PNG);
    if (path === '/moved') return new Response(null, { status: 302, headers: { location: '/hello.txt' } });
    if (path === '/header') return new Response(`${request.headers.get('x-test')}\n`);
    return new Response('not here\n', { status: 404 });
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  let admin: ShellClient | undefined;
  let anna: ShellClient | undefined;

  await harness.start();
  try {
    admin = await harness.createShellClient();

    await t.step('the body goes to stdout', async () => {
      const result = await admin!.exec(`curl -s ${base}/hello.txt`, { json: false });
      assertEquals(text(result), 'hello from the web\n');
    });

    await t.step('-o writes a file, with its size and type recorded', async () => {
      const result = await admin!.exec(`mkdir -p /tmp/curl && curl -s -o /tmp/curl/picture.png ${base}/files/sail%20boat.png; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'code=0');

      const node = await admin!.exec('stat /tmp/curl/picture.png');
      const attrs = (node.data as { attrs: { size: number; mimetype: string } }).attrs;
      assertEquals(attrs.size, PNG.length);
      assertEquals(attrs.mimetype, 'image/png');
    });

    await t.step('-O names the file after the URL, and a second fetch replaces it', async () => {
      await admin!.exec(`cd /tmp/curl && curl -sO ${base}/files/sail%20boat.png && curl -sO ${base}/files/sail%20boat.png`, { json: false });
      const listing = await admin!.exec('ls /tmp/curl', { json: false });
      assertStringIncludes(text(listing), 'sail boat.png');
      assertEquals(text(listing).includes('(2)'), false);
    });

    await t.step('redirects are followed only with -L', async () => {
      const plain = await admin!.exec(`curl -s ${base}/moved; echo "code=$?"`, { json: false });
      assertEquals(text(plain), 'code=0\n');

      const followed = await admin!.exec(`curl -sL ${base}/moved`, { json: false });
      assertEquals(text(followed), 'hello from the web\n');
    });

    await t.step('-f fails with 22 on an HTTP error and writes no file', async () => {
      const result = await admin!.exec(`curl -sf -o /tmp/curl/missing ${base}/missing 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'returned error: 404');
      assertStringIncludes(text(result), 'code=22');

      const exists = await admin!.exec('ls /tmp/curl/missing 2>&1; true', { json: false });
      assertStringIncludes(text(exists), 'Node not found');
    });

    await t.step('-H sends a header', async () => {
      const result = await admin!.exec(`curl -s -H "X-Test: sailboat" ${base}/header`, { json: false });
      assertEquals(text(result), 'sailboat\n');
    });

    await t.step('only http and https are fetched', async () => {
      const result = await admin!.exec('curl -s file:///etc/passwd 2>&1; echo "code=$?"', { json: false });
      assertStringIncludes(text(result), 'protocol "file" not supported');
      assertStringIncludes(text(result), 'code=1');
    });

    await t.step('anyone but the administrator is refused', async () => {
      await admin!.exec('user-create anna && user-passwd anna --new-password secret');
      anna = await harness.createShellClient({ username: 'anna', password: 'secret' });
      const result = await anna.exec(`curl -s ${base}/hello.txt 2>&1; echo "code=$?"`, { json: false });
      assertStringIncludes(text(result), 'only the administrator may fetch URLs');
      assertStringIncludes(text(result), 'code=1');
    });
  } finally {
    anna?.close();
    admin?.close();
    await harness.stop();
    await server.shutdown();
  }
});
