/**
 * A node's socket URL is the page's own host, or another EiN's, over `ws:` or `wss:`, its path
 * encoded, its mode, ticket and invitation in the query; an invitation's link gives its EiN and token.
 */

import { assertEquals } from '@std/assert';
import { nodeSocketUrl, parseInvitationLink } from '../node-socket.ts';

Deno.test('nodeSocketUrl', () => {
  assertEquals(nodeSocketUrl('/groups/club/board', 'w', {}, { protocol: 'https:', host: 'ein.example' }), 'wss://ein.example/file/groups/club/board?mode=w');
  assertEquals(nodeSocketUrl('/tmp/a b#1', 'r', {}, { protocol: 'http:', host: 'ein.local:8080' }), 'ws://ein.local:8080/file/tmp/a%20b%231?mode=r');
  assertEquals(
    nodeSocketUrl('/dev/cam/main.jpg', 'r', { ticket: 't&1' }, { protocol: 'http:', host: 'ein.local' }),
    'ws://ein.local/file/dev/cam/main.jpg?mode=r&ticket=t%261',
  );
  assertEquals(
    nodeSocketUrl('/tmp/board/in', 'w', { origin: 'https://other.example', invite: 'Abc123' }, { protocol: 'http:', host: 'ein.local' }),
    'wss://other.example/file/tmp/board/in?mode=w&invite=Abc123',
  );
});

Deno.test('parseInvitationLink', () => {
  assertEquals(parseInvitationLink('https://other.example/__invite/Abc123', 'http://ein.local/'), { origin: 'https://other.example', token: 'Abc123' });
  assertEquals(parseInvitationLink(' /__invite/Abc123 ', 'http://ein.local:8080/x'), { origin: 'http://ein.local:8080', token: 'Abc123' });
  assertEquals(parseInvitationLink('https://other.example/s/Abc123', 'http://ein.local/'), undefined);
  assertEquals(parseInvitationLink('javascript:alert(1)//__invite/Abc', 'http://ein.local/'), undefined);
});
