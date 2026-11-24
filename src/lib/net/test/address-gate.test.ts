/**
 * Where a gate lets a module ask: the public internet, and off it only what `local` allows; a host
 * refused when any of its addresses is; the proxy refusing what the check before it did not see; a
 * redirect checked a hop at a time, its authorization kept to its origin; and an answer read only up
 * to its limit.
 */
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { AddressGate, inNetworks, isPublicAddress, readAtMost } from '../address-gate.ts';

Deno.test('public addresses, and the ones that are not', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5', '::ffff:93.184.216.34', '64:ff9b::808:808']) assertEquals(isPublicAddress(ip), true, ip);
  const inside = [
    '0.0.0.0',
    '127.0.0.1',
    '10.89.0.4',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:c0a8:101::1',
    '2001:db8::1',
    'not-an-address',
  ];
  for (const ip of inside) assertEquals(isPublicAddress(ip), false, ip);
});

Deno.test('off the public internet, only the networks named', () => {
  const home = new AddressGate({ local: inNetworks('192.168.1.0/24, 127.0.0.1 fd00::/8') });
  for (const ip of ['8.8.8.8', '192.168.1.20', '::ffff:192.168.1.20', '127.0.0.1', '::ffff:127.0.0.1', 'fd00::1']) assertEquals(home.allows(ip), true, ip);
  for (const ip of ['192.168.2.1', '127.0.0.2', '169.254.169.254', '10.89.0.4', 'fe80::1', '::1', 'not-an-address']) assertEquals(home.allows(ip), false, ip);
  for (const text of ['192.168.1.0/33', 'fd00::/129', 'lan', '192.168.1.0/24/8', '192.168.1.0/x']) {
    assertThrows(() => inNetworks(text), Error, 'is not an address or a network', text);
  }
});

Deno.test('a host is refused when any of its addresses is, saying where to allow it', async () => {
  const gate = new AddressGate({ refusal: 'name its network in CFG_X' });
  for (const host of ['127.0.0.1', '[::1]', '169.254.169.254']) {
    await assertRejects(() => gate.check(host), Error, `${host} is not on the public internet; name its network in CFG_X`);
  }
  await assertRejects(() => gate.check('2130706433'), Error, 'has no address');
  await assertRejects(() => gate.check('localhost'), Error);
  assertEquals(await gate.check('93.184.216.34'), ['93.184.216.34']);
  assertEquals(await new AddressGate({ local: inNetworks('169.254.0.0/16') }).check('169.254.169.254'), ['169.254.169.254']);
});

Deno.test({ name: 'asking through the gate', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const hits: [string, string | null][] = [];
  const serve = (handler: (path: string) => Response) =>
    Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, (request) => {
      const path = new URL(request.url).pathname;
      hits.push([path, request.headers.get('authorization')]);
      return handler(path);
    });
  const other = serve(() => new Response('the other'));
  const site = serve((path) => {
    if (path === '/hop') return new Response(null, { status: 302, headers: { location: '/page' } });
    if (path === '/away') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.addr.port}/there` } });
    if (path === '/inside') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.2/' } });
    if (path === '/to-file') return new Response(null, { status: 302, headers: { location: 'file:///etc/hostname' } });
    if (path === '/big') return new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(2048)), c.close()) }));
    return new Response('a page');
  });
  const base = `http://127.0.0.1:${site.addr.port}`;
  const gate = new AddressGate({ local: inNetworks('127.0.0.1') });
  const closed = new AddressGate();
  try {
    await t.step('a host off the public internet is refused before anything is sent', async () => {
      await assertRejects(() => closed.fetch(`${base}/page`), Error, 'is not on the public internet');
      assertEquals(hits, []);
    });

    await t.step('the proxy refuses a host the check did not see', async () => {
      await assertRejects(() => fetch(`${base}/page`, { client: closed.client() } as RequestInit));
      assertEquals(hits, []);
    });

    await t.step('one that local allows is asked through the proxy', async () => {
      assertEquals(await (await gate.fetch(`${base}/page`)).text(), 'a page');
      assertEquals(hits.splice(0), [['/page', null]]);
    });

    await t.step('only http and https', async () => {
      for (const url of ['file:///etc/hostname', 'data:text/html,<p>', 'ftp://192.0.2.1/']) await assertRejects(() => gate.fetch(url), Error, 'only http and https');
    });

    await t.step('a redirect is followed a hop at a time, and checked like the first', async () => {
      assertEquals(await (await gate.fetch(`${base}/hop`)).text(), 'a page');
      assertEquals(hits.splice(0).map(([path]) => path), ['/hop', '/page']);
      await assertRejects(() => gate.fetch(`${base}/inside`), Error, '127.0.0.2 is not on the public internet');
      await assertRejects(() => gate.fetch(`${base}/to-file`), Error, 'only http and https');
      hits.splice(0);
    });

    await t.step('the authorization goes only to the origin it was given for', async () => {
      const headers = { authorization: 'Basic YTpi' };
      await (await gate.fetch(`${base}/hop`, { headers })).text();
      await (await gate.fetch(`${base}/away`, { headers })).text();
      assertEquals(hits.splice(0), [['/hop', 'Basic YTpi'], ['/page', 'Basic YTpi'], ['/away', 'Basic YTpi'], ['/there', null]]);
    });

    await t.step('an answer of no stated length is read only up to its limit', async () => {
      assertEquals((await readAtMost(await gate.fetch(`${base}/big`), 4096, () => new Error('too long'))).length, 2048);
      await assertRejects(async () => await readAtMost(await gate.fetch(`${base}/big`), 1024, () => new Error('too long')), Error, 'too long');
    });
  } finally {
    gate.close();
    closed.close();
    await site.shutdown();
    await other.shutdown();
  }
});
