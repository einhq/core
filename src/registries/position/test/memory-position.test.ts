/**
 * Fast tier: position conformance against the in-memory implementation.
 */

import { MemoryPositionRegistry } from '../mod.ts';
import { positionConformanceTests } from './position-conformance.ts';

positionConformanceTests('MemoryPositionRegistry conformance', async () => {
  const registry = new MemoryPositionRegistry();
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
    },
  };
});
