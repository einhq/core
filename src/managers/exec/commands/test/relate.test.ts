/**
 * Relation command tests: relate/unrelate softlink pairs, asymmetric labels,
 * reciprocal delete via the relations-guard service.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

Deno.test({
  name: 'relations',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p /archive/people/anna && mkdir -p /archive/people/erik && mkdir -p /archive/people/mia`);

    await t.step('relate creates softlink pairs with relation attrs', async () => {
      await cmd.shouldSucceed(`relate /archive/people/anna /archive/people/erik partner`);

      const aAttrs = await client.execJson<{ relation: { label: string; peerLink: string } }>(
        `attrs -L /archive/people/anna/relations/partner-erik`,
      );
      assertEquals(aAttrs.relation.label, 'partner');
      assertEquals(aAttrs.relation.peerLink, `/archive/people/erik/relations/partner-anna`);

      const bAttrs = await client.execJson<{ relation: { label: string; peerLink: string } }>(
        `attrs -L /archive/people/erik/relations/partner-anna`,
      );
      assertEquals(bAttrs.relation.label, 'partner');
      assertEquals(bAttrs.relation.peerLink, `/archive/people/anna/relations/partner-erik`);
    });

    await t.step('relate rejects duplicates', async () => {
      await cmd.shouldFail(`relate /archive/people/anna /archive/people/erik partner`);
    });

    await t.step('unrelate removes both sides', async () => {
      await cmd.shouldSucceed(`unrelate /archive/people/anna /archive/people/erik partner`);

      const out = await client.execString(`ls /archive/people/anna/relations`);
      assertEquals(out.includes('partner-erik'), false, out);
      const out2 = await client.execString(`ls /archive/people/erik/relations`);
      assertEquals(out2.includes('partner-anna'), false, out2);
    });

    await t.step('asymmetric labels via --reverse', async () => {
      await cmd.shouldSucceed(`relate /archive/people/anna /archive/people/mia parent --reverse child`);

      const aAttrs = await client.execJson<{ relation: { label: string } }>(
        `attrs -L /archive/people/anna/relations/parent-mia`,
      );
      assertEquals(aAttrs.relation.label, 'parent');

      const bAttrs = await client.execJson<{ relation: { label: string } }>(
        `attrs -L /archive/people/mia/relations/child-anna`,
      );
      assertEquals(bAttrs.relation.label, 'child');
    });

    await t.step('guard removes the peer when one side is rm-ed', async () => {
      const status = await client.execString('service status relations-guard');
      assertEquals(status.includes('running'), true, status);

      await cmd.shouldSucceed(`rm /archive/people/anna/relations/parent-mia`);

      const gone = await waitFor(async () => {
        const out = await client.execString(`ls /archive/people/mia/relations`);
        return !out.includes('child-anna');
      });
      assertEquals(gone, true, 'peer link was not removed by the guard');
    });

    // Both halves of this pair live in one relations/ directory, so the guard's
    // cleanup wants the mutex the rm that triggered it holds: the guard must
    // clean up after the rm returns, not inline.
    await t.step('rm returns when the peer link shares its directory', async () => {
      await cmd.shouldSucceed(`relate /archive/people/anna /archive/people/anna friend --reverse buddy`);

      const timeout = Symbol('timeout');
      const timer = new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), 15_000));
      const result = await Promise.race([
        client.exec(`rm /archive/people/anna/relations/friend-anna`).then(() => 'done'),
        timer,
      ]);
      assertEquals(result, 'done', 'rm of a relation link did not return');

      const gone = await waitFor(async () => {
        const out = await client.execString(`ls /archive/people/anna/relations`);
        return !out.includes('friend-anna') && !out.includes('buddy-anna');
      });
      assertEquals(gone, true, 'guard left half the pair behind');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
