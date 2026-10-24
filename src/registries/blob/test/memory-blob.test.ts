import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { MemoryBlobRegistry } from '../mod.ts';

binaryConformanceTests('MemoryBlobRegistry conformance', async () => {
  const registry = new MemoryBlobRegistry();
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
});
