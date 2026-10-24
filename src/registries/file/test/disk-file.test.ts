import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { DiskFileRegistry } from '../mod.ts';

binaryConformanceTests('DiskFileRegistry conformance', async () => {
  const root = await Deno.makeTempDir({ prefix: 'mrx-disk-file-' });
  const registry = new DiskFileRegistry({ rootPath: root });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await Deno.remove(root, { recursive: true });
    },
  };
}, { times: true });
