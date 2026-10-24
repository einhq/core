/**
 * BoundRoutingKeys is a negative cache in front of postgres, so every test here
 * is about the one direction it must never be wrong in: saying "not bound" about
 * a key that is. Being too permissive costs a query that would have run anyway.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { deferred } from '../../lib/async/deferred.ts';
import { BoundRoutingKeys } from '../bound-routing-keys.ts';

Deno.test('unloaded answers yes to everything', () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve([]));

  assertFalse(bound.loaded);
  // The dangerous alternative would be an empty set, which reads as "nothing is
  // bound" and drops every event until the first load lands.
  assert(bound.has('system.vfs.file.created'));
  assert(bound.has('anything.at.all'));
});

Deno.test('after loading, only bound keys pass', async () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve(['system.vfs.file.created']));
  await bound.refresh();

  assert(bound.loaded);
  assert(bound.has('system.vfs.file.created'));
  assertFalse(bound.has('system.vfs.tty.updated'));
});

Deno.test('a failed load falls back to permissive', async () => {
  let fail = true;
  const bound = new BoundRoutingKeys(() => fail ? Promise.reject(new Error('nope')) : Promise.resolve(['a']));

  await bound.refresh();
  assertFalse(bound.loaded);
  assert(bound.has('anything'), 'a registry that cannot read its bindings must not drop events');

  fail = false;
  await bound.refresh();
  assert(bound.loaded);
  assertFalse(bound.has('anything'));
});

Deno.test('add() widens ahead of the write that binds the key', async () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve([]));
  await bound.refresh();

  assertFalse(bound.has('system.vfs.file.created'));

  // This is the subscribe/publish race: the caller adds before its INSERT, so an
  // event arriving mid-flight still reaches the fanout.
  bound.add(['system.vfs.file.created']);
  assert(bound.has('system.vfs.file.created'));
});

Deno.test('add() on an unloaded cache stays permissive rather than narrowing', () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve([]));

  bound.add(['one']);

  // Must not have silently become a loaded set containing only 'one'.
  assertFalse(bound.loaded);
  assert(bound.has('two'));
});

Deno.test('invalidate() reopens everything', async () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve(['a']));
  await bound.refresh();
  assertFalse(bound.has('b'));

  bound.invalidate();
  assert(bound.has('b'));
});

Deno.test('a refresh requested mid-load is not swallowed by the in-flight read', async () => {
  // The race: a NOTIFY arrives while a load is already running. That running
  // query started before the change committed, so its result is stale and must
  // not be installed — otherwise the notification is lost and the cache stays
  // wrong until the next one.
  const gate = deferred<void>();
  let call = 0;
  const keys = [['old'], ['new']];

  const bound = new BoundRoutingKeys(async () => {
    const index = call++;
    if (index === 0) await gate;
    return keys[index];
  });

  const first = bound.refresh();
  const second = bound.refresh(); // lands while the first is parked on the gate

  gate.resolve();
  await Promise.all([first, second]);

  assertEquals(call, 2, 'the second request must force a reload, not reuse the in-flight one');
  assert(bound.has('new'));
  assertFalse(bound.has('old'));
});

Deno.test('concurrent refreshes coalesce into one load', async () => {
  let call = 0;
  const bound = new BoundRoutingKeys(() => {
    call++;
    return Promise.resolve(['a']);
  });

  await Promise.all([bound.refresh(), bound.refresh(), bound.refresh()]);

  // Two at most: the first load, plus one re-run for the requests that arrived
  // while it was in flight. Never one per caller.
  assert(call <= 2, `expected at most 2 loads, got ${call}`);
  assert(bound.has('a'));
});

Deno.test('a bound pattern passes the keys it covers', async () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve(['system.vfs.file.*', 'system.events']));
  await bound.refresh();

  assert(bound.has('system.vfs.file.created'));
  assert(bound.has('system.vfs.file.updated'));
  assert(bound.has('system.events'));
  // The whole point of the cache: the firehose key still costs nothing.
  assertFalse(bound.has('system.vfs.tty.updated'));
  assertFalse(bound.has('system.vfs.file.a.b'));
});

Deno.test('add() widens by pattern too', async () => {
  const bound = new BoundRoutingKeys(() => Promise.resolve([]));
  await bound.refresh();

  assertFalse(bound.has('media.face.detected'));

  bound.add(['media.#']);

  assert(bound.has('media.face.detected'), 'the subscribe/publish race must not drop a pattern binding');
  assertFalse(bound.has('system.vfs.tty.updated'));

  // Re-adding the same pattern must not stack another copy to test against.
  bound.add(['media.#']);
  assert(bound.has('media.file.discovered'));
});
