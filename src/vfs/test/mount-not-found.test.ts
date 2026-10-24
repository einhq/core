/**
 * A missing node under a mount is reported by the path the caller asked for.
 *
 * The mounted VFS only knows paths from its own root; `ls /tmp/x` says
 * `/tmp/x`, not `/x` — a path the user never named.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeNotFoundError } from '../errors.ts';

Deno.test('not-found under a mount names the full path, through nested mounts too', async () => {
  const outer = await createTestVfs();
  const tmp = await createTestVfs();
  const inner = await createTestVfs();
  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'tmp', { props: { mode: 0o755 } });
  await outer.vfs.mount(ADMIN_ACCESS, '/tmp', tmp.vfs);
  await tmp.vfs.create(ADMIN_ACCESS, 'directory', '/', 'inner', { props: { mode: 0o755 } });
  await tmp.vfs.mount(ADMIN_ACCESS, '/inner', inner.vfs);

  const missing = async (path: string) => (await assertRejects(() => outer.vfs.get(ADMIN_ACCESS, path), NodeNotFoundError)).message;

  assertEquals(await missing('/tmp/nope'), 'Node not found: /tmp/nope');
  assertEquals(await missing('/tmp/no/such/dir'), 'Node not found: /tmp/no/such/dir');
  assertEquals(await missing('/tmp/inner/nope'), 'Node not found: /tmp/inner/nope');
  // Outside any mount.
  assertEquals(await missing('/nope'), 'Node not found: /nope');
  // And a node that is there is still found.
  const here = await tmp.vfs.create(ADMIN_ACCESS, 'file', '/', 'here', { props: { mode: 0o644 } });
  assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/tmp/here')).id, here.id);
});
