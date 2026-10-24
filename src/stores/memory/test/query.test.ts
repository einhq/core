/**
 * Fast tier: NodeQuery conformance against InMemoryStore, alone and mounted as the primary mounts
 * its data store.
 */

import { createTestVfs } from '../../../testing/test-vfs.ts';
import { runQueryConformance } from '../../test/query-conformance.ts';

Deno.test('InMemoryStore node query conformance', async (t) => {
  await runQueryConformance(t, async () => {
    const test = await createTestVfs();
    return { vfs: test.vfs, dispose: () => test.dispose() };
  });
});

Deno.test('InMemoryStore node query conformance, mounted at / under a router-only root', async (t) => {
  // The production shape: a query or an aggregate merges the root's own store with the mount, and
  // `within` is routed to the store holding its root.
  await runQueryConformance(t, async () => {
    const test = await createTestVfs({ rootMount: true });
    return { vfs: test.vfs, dispose: () => test.dispose() };
  });
});
