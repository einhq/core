import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryQueueRegistry } from '../mod.ts';
import { queueConformanceTests } from './queue-conformance.ts';

queueConformanceTests('MemoryQueueRegistry conformance', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new MemoryQueueRegistry({ router });
  await registry.init();

  const internals = registry as unknown as { messages: Map<number, unknown>; deliveries: Map<number, unknown> };

  return {
    registry,
    router,
    retained: () => Promise.resolve({ messages: internals.messages.size, deliveries: internals.deliveries.size }),
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
    },
  };
});
