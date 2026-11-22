/**
 * POST /checksums: which sha256 checksums the asker already has, among the files they can read
 * outside every trash, answered as known or not and never as a path.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, GUEST_GID, GUEST_UID } from '../../../lib/access/mod.ts';
import { homePath } from '../../../lib/paths.ts';
import { trashPut } from '../../../lib/trash/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { CHECKSUMS_MAX } from '../handlers/post-checksums.ts';

const harness = new SystemTestHarness({ ssh: false });

const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');

Deno.test({
  name: 'HTTP checksums endpoint',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl, vfs } = await harness.start();
  const { cookie } = await harness.createHttpSession();

  const put = async (path: string, body: string) => {
    const res = await fetch(`${baseUrl}/file${path}`, { method: 'PUT', headers: { cookie }, body });
    assertEquals(res.status, 201);
    await res.body?.cancel();
  };

  const ask = (body: unknown, as = cookie) =>
    fetch(`${baseUrl}/checksums`, {
      method: 'POST',
      headers: { cookie: as, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const known = async (sha256s: string[], as = cookie): Promise<string[]> => {
    const res = await ask({ sha256: sha256s }, as);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('cache-control'), 'no-store');
    return (await res.json()).known;
  };

  try {
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/tmp', 'open', { props: { mode: 0o755 } });
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/tmp', 'closed', { props: { mode: 0o700 } });
    await put('/tmp/open/beach.jpg', 'a day at the beach');
    await put('/tmp/closed/garden.jpg', 'a garden in bloom');
    const beach = await sha256('a day at the beach');
    const garden = await sha256('a garden in bloom');
    const never = await sha256('never sent');

    await t.step('answers the known ones, lowercase and in the order asked', async () => {
      assertEquals(await known([never, garden.toUpperCase(), beach, garden]), [garden, beach]);
      assertEquals(await known([never]), []);
    });

    await t.step('a file the asker cannot read is not known to them', async () => {
      const { cookie: other } = await harness.createHttpSession({ uid: 3000, gid: 3000, gids: [3000] });
      assertEquals(await known([beach, garden], other), [beach]);
    });

    await t.step('a file in a trash is not known', async () => {
      const home = homePath('admin');
      await put(`${home}/meadow.jpg`, 'a meadow');
      const meadow = await sha256('a meadow');
      assertEquals(await known([meadow]), [meadow]);
      await trashPut(vfs, ADMIN_ACCESS, home, [`${home}/meadow.jpg`]);
      assertEquals(await known([meadow]), []);
    });

    await t.step('the guest and a request without a session are refused', async () => {
      const { cookie: guest } = await harness.createHttpSession({ uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] });
      const res = await ask({ sha256: [beach] }, guest);
      assertEquals(res.status, 401);
      await res.body?.cancel();
      const bare = await fetch(`${baseUrl}/checksums`, { method: 'POST', body: JSON.stringify({ sha256: [beach] }) });
      assertEquals(bare.status, 401);
      await bare.body?.cancel();
    });

    await t.step('a body that is not a list of 1 to CHECKSUMS_MAX checksums is refused', async () => {
      for (const body of [{}, { sha256: [] }, { sha256: ['beach.jpg'] }, { sha256: [beach.slice(1)] }, { sha256: [42] }, { sha256: Array(CHECKSUMS_MAX + 1).fill(beach) }]) {
        const res = await ask(body);
        assertEquals(res.status, 400, JSON.stringify(body).slice(0, 80));
        await res.body?.cancel();
      }
      const res = await fetch(`${baseUrl}/checksums`, { method: 'POST', headers: { cookie }, body: 'not json' });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });
  } finally {
    await harness.stop();
  }
});
