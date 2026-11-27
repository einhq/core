/**
 * A socket has one listener at a time; a client connects only while it listens, and what it writes
 * before it is accepted waits; each connection carries whole messages both ways between its client
 * and the listener alone, says who connected, ends for both ends when either closes, ends with the
 * listener or the node, is let go when an end falls behind, and is refused past the backlog.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { isSocketConnection, isSocketListener, SocketRegistry } from '../mod.ts';
import type { SocketConnection, SocketListener } from '../mod.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const anna = { uid: 1001, gid: 100 };
const bo = { uid: 1002, gid: 100, invitation: '0123456789abcdef' };

Deno.test('SocketRegistry', async (t) => {
  await t.step('a client and the listener exchange whole messages, each connection its own', async () => {
    const registry = new SocketRegistry();
    const listener = await registry.open('s', {}, 'r');
    assert(isSocketListener(listener));
    const first = await registry.open('s', { peer: anna }, 'w');
    assert(isSocketConnection(first));
    await first.write(bytes('written before it was accepted'));
    const second = await registry.open('s', { peer: bo }, 'r+') as SocketConnection;
    await second.write(bytes('from bo'));

    const one = (await listener.accept())!;
    const two = (await listener.accept())!;
    assertEquals(one.peer, anna);
    assertEquals(two.peer, bo);
    assertEquals(text(await one.read(1024)), 'written before it was accepted');
    assertEquals(text(await two.read(1024)), 'from bo');

    await one.write(bytes('to anna'));
    await two.write(bytes('to bo, '));
    await two.write(bytes('twice'));
    assertEquals(text(await first.read(1024)), 'to anna');
    assertEquals(text(await second.read(1024)), 'to bo, ');
    assertEquals(text(await second.read(3)), 'twi');
    assertEquals(text(await second.read(1024)), 'ce');
    assertEquals(await registry.stat('s'), { size: 0, listening: true, connections: 2 });
    await listener.close();
  });

  await t.step('one listener at a time, and nobody connects without one', async () => {
    const registry = new SocketRegistry();
    await assertRejects(() => registry.open('s', { peer: anna }, 'w'), Error, 'nobody listens');
    const listener = await registry.open('s', {}, 'r');
    await assertRejects(() => registry.open('s', {}, 'r'), Error, 'a listener already');
    await listener.close();
    const again = await registry.open('s', {}, 'r');
    await again.close();
    assertEquals(await registry.stat('s'), { size: 0, listening: false, connections: 0 });
  });

  await t.step('either end closing ends the connection for both, after what the other holds', async () => {
    const registry = new SocketRegistry();
    const listener = await registry.open('s', {}, 'r') as SocketListener;
    const client = await registry.open('s', { peer: anna }, 'w');
    const server = (await listener.accept())!;
    await server.write(bytes('last words'));
    await server.close();
    assertEquals(text(await client.read(1024)), 'last words');
    assertEquals((await client.read(1024)).length, 0);
    await assertRejects(() => client.write(bytes('too late')), Error, 'has ended');
    await client.close();

    const other = await registry.open('s', { peer: bo }, 'w');
    const accepted = (await listener.accept())!;
    const reading = accepted.read(1024);
    await other.close();
    assertEquals((await reading).length, 0);
    assertEquals(await registry.stat('s'), { size: 0, listening: true, connections: 0 });
    await listener.close();
  });

  await t.step('the listener closing or the node going ends every connection, and accept answers nothing', async () => {
    const registry = new SocketRegistry();
    const listener = await registry.open('s', {}, 'r') as SocketListener;
    const accepted = await registry.open('s', { peer: anna }, 'w');
    const waiting = await registry.open('s', { peer: bo }, 'w');
    await listener.accept();
    await listener.close();
    assertEquals((await accepted.read(1024)).length, 0);
    assertEquals((await waiting.read(1024)).length, 0);
    assertEquals(await listener.accept(), undefined);

    const next = await registry.open('s', {}, 'r') as SocketListener;
    const pending = next.accept();
    const client = await registry.open('s', { peer: anna }, 'w');
    assertEquals((await pending)?.peer, anna);
    const accepting = next.accept();
    assert(await registry.delete('s'));
    assertEquals(await accepting, undefined);
    assertEquals((await client.read(1024)).length, 0);
  });

  await t.step('an end that falls behind lets the connection go', async () => {
    const registry = new SocketRegistry({ buffer: 8 });
    const listener = await registry.open('s', {}, 'r') as SocketListener;
    const client = await registry.open('s', { peer: anna }, 'w') as SocketConnection;
    const server = (await listener.accept())!;
    await server.write(bytes('12345'));
    await server.write(bytes('67890'));
    assert(client.behind);
    assertEquals(text(await client.read(1024)), '12345');
    assertEquals((await client.read(1024)).length, 0);
    await assertRejects(() => server.write(bytes('more')), Error, 'has ended');
    await listener.close();
  });

  await t.step('past the backlog a connection is refused', async () => {
    const registry = new SocketRegistry({ backlog: 1 });
    const listener = await registry.open('s', {}, 'r') as SocketListener;
    await registry.open('s', { peer: anna }, 'w');
    await assertRejects(() => registry.open('s', { peer: bo }, 'w'), Error, 'too many connections waiting');
    await listener.accept();
    await registry.open('s', { peer: bo }, 'w');
    await listener.close();
  });

  await t.step('a wait for a connection stops with its signal', async () => {
    const registry = new SocketRegistry();
    const listener = await registry.open('s', {}, 'r') as SocketListener;
    const stop = new AbortController();
    const accepting = listener.accept(stop.signal);
    stop.abort(new Error('stopped'));
    await assertRejects(() => accepting, Error, 'stopped');
    await listener.close();
  });
});
