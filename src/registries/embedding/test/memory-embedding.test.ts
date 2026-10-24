import { MemoryEmbeddingRegistry } from '../mod.ts';
import { embeddingConformanceTests } from './embedding-conformance.ts';

embeddingConformanceTests('MemoryEmbeddingRegistry conformance', async () => {
  const registry = new MemoryEmbeddingRegistry();
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
});
