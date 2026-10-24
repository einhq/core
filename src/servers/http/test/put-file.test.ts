import { assertEquals } from '@std/assert';
import { NodeAlreadyExistsError, NodeNotFoundError } from '../../../vfs/mod.ts';
import { handlePutFile } from '../handlers/put-file.ts';
import type { HttpServerConfig } from '../types.ts';

/**
 * A PUT that finds its path free and then loses the create to another request writes into the
 * file that request made, rather than failing. The facade plays the other request: the path is
 * missing until this one tries to create it, and taken by then.
 */
Deno.test('PUT that loses the create race writes into the winner', async () => {
  const written: Uint8Array[] = [];
  let created = false;
  const config = {
    env: { COOKIE_NAME: 'session' },
    vfs: {
      exists: () => Promise.resolve(created),
      create: () => {
        created = true;
        return Promise.reject(new NodeAlreadyExistsError('parent-id', 'race.txt'));
      },
      open: (_access: unknown, path: string) =>
        created
          ? Promise.resolve({
            writable: new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk) }),
            close: () => Promise.resolve(),
          })
          : Promise.reject(new NodeNotFoundError(path)),
      update: (_access: unknown, _path: string, opts: { attrs: Record<string, unknown> }) => Promise.resolve({ attrs: opts.attrs }),
    },
  } as unknown as HttpServerConfig;

  const req = new Request('http://localhost/file/tmp/race.txt', { method: 'PUT', body: 'late' });
  const res = await handlePutFile(config, req, new URL(req.url));

  assertEquals(res.status, 201);
  assertEquals((await res.json()).size, 4);
  assertEquals(new TextDecoder().decode(written[0]), 'late');
});
