/**
 * PathCache on its own: what counts as a hit, what a drop forgets, and what of a walk read before
 * a drop is cached after it.
 */

import { assertEquals } from '@std/assert';
import type { NodeId, ResolvedNodeChain } from '../../../vfs/mod.ts';
import { PathCache } from '../path-cache.ts';

const ROOT = 'root' as NodeId;
const A = 'a' as NodeId;
const B = 'b' as NodeId;

const props = (mode: number) => ({ mode, uid: 1000, gid: 1000 });

/** `/a/b` as the store would answer it. */
const walkAB: ResolvedNodeChain = {
  root: { id: ROOT, props: props(0o755) },
  entries: [
    { id: A, name: 'a', props: props(0o755) },
    { id: B, name: 'b', props: props(0o644) },
  ],
};

const ids = (chain: ResolvedNodeChain | undefined) => chain?.entries.map((entry) => entry.id);

Deno.test('PathCache answers a walk only when every step is known', async (t) => {
  await t.step('an empty cache answers nothing', () => {
    assertEquals(new PathCache().chain(ROOT, ['a']), undefined);
  });

  await t.step('a filled walk comes back, and so does any prefix of it', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['a', 'b'], walkAB);

    assertEquals(cache.chain(ROOT, ['a', 'b']), walkAB);
    assertEquals(ids(cache.chain(ROOT, ['a'])), [A]);
    assertEquals(ids(cache.chain(ROOT, [])), []);
  });

  await t.step('a step past what was filled is unknown, not missing', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['a', 'b'], walkAB);

    assertEquals(cache.chain(ROOT, ['a', 'b', 'c']), undefined);
    assertEquals(cache.chain(ROOT, ['a', 'other']), undefined);
  });

  await t.step('a walk that stopped short is remembered as stopping there', () => {
    const cache = new PathCache();
    const stopped: ResolvedNodeChain = { root: walkAB.root, entries: [walkAB.entries[0]] };
    cache.fill(cache.version, ROOT, ['a', 'nope', 'c'], stopped);

    assertEquals(ids(cache.chain(ROOT, ['a', 'nope'])), [A]);
    assertEquals(ids(cache.chain(ROOT, ['a', 'nope', 'anything'])), [A]);
  });
});

Deno.test('PathCache forgets what a write drops', async (t) => {
  await t.step('dropEdge makes walks through that edge unknown and leaves the rest', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['a', 'b'], walkAB);
    cache.dropEdge(A, 'b');

    assertEquals(cache.chain(ROOT, ['a', 'b']), undefined);
    assertEquals(ids(cache.chain(ROOT, ['a'])), [A]);
  });

  await t.step('dropEdge forgets that a name was missing', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['nope'], { root: walkAB.root, entries: [] });
    cache.dropEdge(ROOT, 'nope');

    assertEquals(cache.chain(ROOT, ['nope']), undefined);
  });

  await t.step('dropNode makes every walk through the node unknown', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['a', 'b'], walkAB);
    cache.dropNode(A);

    assertEquals(cache.chain(ROOT, ['a']), undefined);
    assertEquals(cache.chain(ROOT, ['a', 'b']), undefined);
  });

  await t.step('dropping the root forgets every walk from it', () => {
    const cache = new PathCache();
    cache.fill(cache.version, ROOT, ['a', 'b'], walkAB);
    cache.dropNode(ROOT);

    assertEquals(cache.chain(ROOT, []), undefined);
  });

  await t.step('a walk read before a drop is cached without what the drop changed', () => {
    const cache = new PathCache();
    const before = cache.version;
    cache.dropEdge(A, 'b');
    cache.fill(before, ROOT, ['a', 'b'], walkAB);

    assertEquals(ids(cache.chain(ROOT, ['a'])), [A]);
    assertEquals(cache.chain(ROOT, ['a', 'b']), undefined);
  });

  await t.step('a walk read before a node drop is cached without that node', () => {
    const cache = new PathCache();
    const before = cache.version;
    cache.dropNode(B);
    cache.fill(before, ROOT, ['a', 'b'], walkAB);

    assertEquals(ids(cache.chain(ROOT, ['a'])), [A]);
    assertEquals(cache.chain(ROOT, ['a', 'b']), undefined);
  });

  await t.step('a walk read before more drops than are remembered is not cached', () => {
    const cache = new PathCache(65_536, 2);
    const before = cache.version;
    cache.dropEdge(ROOT, 'x');
    cache.dropEdge(ROOT, 'y');
    cache.dropEdge(ROOT, 'z');
    cache.fill(before, ROOT, ['a', 'b'], walkAB);

    assertEquals(cache.chain(ROOT, []), undefined);
  });

  await t.step('a walk read before clear is not cached', () => {
    const cache = new PathCache();
    const before = cache.version;
    cache.clear();
    cache.fill(before, ROOT, ['a', 'b'], walkAB);

    assertEquals(cache.chain(ROOT, []), undefined);
  });
});

Deno.test('PathCache evicts the least recently used entry', () => {
  // Room for the root and two more nodes: `a`, read again after `b` arrived, outlasts `b`.
  const cache = new PathCache(3);
  const C = 'c' as NodeId;
  const one = (id: NodeId, name: string): ResolvedNodeChain => ({ root: walkAB.root, entries: [{ id, name, props: props(0o755) }] });

  cache.fill(cache.version, ROOT, ['a'], one(A, 'a'));
  cache.fill(cache.version, ROOT, ['b'], one(B, 'b'));
  cache.chain(ROOT, ['a']);
  cache.fill(cache.version, ROOT, ['c'], one(C, 'c'));

  assertEquals(ids(cache.chain(ROOT, ['a'])), [A]);
  assertEquals(cache.chain(ROOT, ['b']), undefined);
  assertEquals(ids(cache.chain(ROOT, ['c'])), [C]);
});
