/**
 * Fast tier: track conformance against the in-memory implementation.
 */

import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryTrackRegistry } from '../mod.ts';
import { trackConformanceTests } from './track-conformance.ts';

trackConformanceTests('MemoryTrackRegistry conformance', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new MemoryTrackRegistry({ router });
  await registry.init();

  return {
    registry,
    router,
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
    },
  };
});
