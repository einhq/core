import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { MemoryFileRegistry } from '../mod.ts';

binaryConformanceTests('MemoryFileRegistry conformance', async () => {
  const registry = new MemoryFileRegistry();
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
}, { times: true });
