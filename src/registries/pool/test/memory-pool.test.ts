import { MemoryPoolRegistry } from '../mod.ts';
import { poolConformanceTests } from './pool-conformance.ts';

poolConformanceTests('MemoryPoolRegistry conformance', async () => {
  const registry = new MemoryPoolRegistry();
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
}, { wakeMs: 300 });
