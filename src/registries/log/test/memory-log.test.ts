import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryLogRegistry } from '../mod.ts';
import { logConformanceTests } from './log-conformance.ts';

logConformanceTests('MemoryLogRegistry conformance', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new MemoryLogRegistry({ router });
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
