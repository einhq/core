/**
 * The client address of a request: the socket's peer, or the forwarded client
 * when the peer is a proxy on this host.
 */

import { assertEquals } from '@std/assert';
import { clientAddress } from '../client-address.ts';

const tcp = (hostname: string): Deno.NetAddr => ({ transport: 'tcp', hostname, port: 40000 });

Deno.test('clientAddress: a direct client is its socket peer', () => {
  assertEquals(clientAddress(new Headers(), tcp('192.0.2.7')), '192.0.2.7');
});

Deno.test('clientAddress: forwarding headers from a remote peer are ignored', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.1', forwarded: 'for=198.51.100.2' });
  assertEquals(clientAddress(headers, tcp('192.0.2.7')), '192.0.2.7');
});

Deno.test('clientAddress: a proxy on this host names the client in X-Forwarded-For', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.2' });
  assertEquals(clientAddress(headers, tcp('127.0.0.1')), '198.51.100.1');
  assertEquals(clientAddress(headers, tcp('::1')), '198.51.100.1');
});

Deno.test('clientAddress: Forwarded for= is read when X-Forwarded-For is absent', () => {
  assertEquals(clientAddress(new Headers({ forwarded: 'for=198.51.100.1:4711;proto=https, for=10.0.0.2' }), tcp('127.0.0.1')), '198.51.100.1');
  assertEquals(clientAddress(new Headers({ forwarded: 'for="[2001:db8::1]:4711"' }), tcp('127.0.0.1')), '2001:db8::1');
});

Deno.test('clientAddress: a proxy on this host that forwards nothing is the client', () => {
  assertEquals(clientAddress(new Headers(), tcp('127.0.0.1')), '127.0.0.1');
});

Deno.test('clientAddress: a unix socket has no address', () => {
  assertEquals(clientAddress(new Headers(), { transport: 'unix', path: '/tmp/ein.sock' }), undefined);
});
