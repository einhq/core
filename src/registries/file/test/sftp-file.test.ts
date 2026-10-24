import { Client } from 'ssh2';
import { SftpConnection } from '../../../lib/ssh/mod.ts';
import { startSshTestServer } from '../../../testing/ssh-test-server.ts';
import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { SftpFileRegistry } from '../sftp-file-registry.ts';

binaryConformanceTests('SftpFileRegistry conformance', async () => {
  const root = await Deno.makeTempDir({ prefix: 'mrx-sftp-file-' });
  const server = await startSshTestServer({ root, password: 'pw' });
  const conn = new SftpConnection({
    label: 'anna@127.0.0.1',
    path: '',
    connect: async () => {
      const client = new Client();
      await client.connect({ host: '127.0.0.1', port: server.port, username: 'anna', password: 'pw', hostVerifier: () => true });
      return client;
    },
  });
  const registry = new SftpFileRegistry(conn);
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await conn.close();
      await server.close();
      await Deno.remove(root, { recursive: true });
    },
  };
  // ssh2 releases its cipher only once the closed socket has drained, after the test has ended.
}, { sanitize: false });
