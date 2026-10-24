/**
 * Fast tier: stored reach conformance against InMemoryStore, over several seeded write sequences.
 */

import { InMemoryStore } from '../index.ts';
import { runReachConformance } from '../../test/reach-conformance.ts';

for (const seed of [674, 1, 2, 3]) {
  Deno.test(`InMemoryStore stored reach agrees with a walk (seed ${seed})`, async (t) => {
    await runReachConformance(t, async () => {
      const store = new InMemoryStore({});
      await store.initialize();
      return { store, dispose: () => store.dispose() };
    }, seed);
  });
}
