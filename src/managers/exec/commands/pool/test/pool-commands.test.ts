/**
 * The pool-* commands over a real shell, which is the only place the JSON-mode
 * contract is actually exercised: the API shell runs every command with
 * JSON_OUTPUT=1 and JSON.parses stdout, so a command that prints a table there
 * takes the whole request down.
 */

import { POOLS_PATH } from '../../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../../../testing/mod.ts';
import type { PoolJob } from '../../../../../registries/pool/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

type Ok = { ok: true; count?: number; id?: number };
type Stat = {
  backlog: number;
  counts: Record<string, number>;
  policy: { agingSeconds: number; agingMax: number; leaseMs: number };
};

Deno.test({
  name: 'pool commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.startPrimary();
  const client = await harness.createShellClient();

  const path = `${POOLS_PATH}/cmdtest`;

  await t.step('mkpool creates a pool node with its policy', async () => {
    await client.exec(`mkdir -p ${POOLS_PATH}`);
    await client.exec(`mkpool --aging-seconds 1800 --aging-max 40 --lease-ms 90000 ${path}`);

    const info = await client.execJson<{ type: string }>(`info ${path}`);
    assertEquals(info.type, 'pool');

    const stat = await client.execJson<Stat>(`pool stat ${path}`);
    assertEquals(stat.backlog, 0);
    assertEquals(stat.policy.agingSeconds, 1800);
    assertEquals(stat.policy.agingMax, 40);
    assertEquals(stat.policy.leaseMs, 90000);
  });

  await t.step('pool-add reports the new job id in JSON mode', async () => {
    const added = await client.execJson<Ok>(
      `pool add ${path} --kind gpu-faces --priority 100 --requires gpu=1,vramMb=3000 --key step-a --params '{"command":"echo hi"}'`,
    );
    assertEquals(added.ok, true);
    assertEquals(typeof added.id, 'number');

    const stat = await client.execJson<Stat>(`pool stat ${path}`);
    assertEquals(stat.backlog, 1);
    assertEquals(stat.counts.ready, 1);
  });

  await t.step('re-adding the same key updates rather than duplicates', async () => {
    await client.exec(`pool add ${path} --kind gpu-faces --priority 100 --key step-a`);
    const stat = await client.execJson<Stat>(`pool stat ${path}`);
    assertEquals(stat.counts.total, 1);
  });

  await t.step('pool-list pages and filters', async () => {
    await client.exec(`pool add ${path} --kind cpu-convert --priority 10 --requires cpu=2 --key step-b`);

    const all = await client.execJson<{ items: PoolJob[]; nextCursor: number | null }>(`pool list ${path}`);
    assertEquals(all.items.length, 2);
    assertEquals(all.nextCursor, null);

    const gpu = await client.execJson<{ items: PoolJob[] }>(`pool list ${path} --kind gpu-faces`);
    assertEquals(gpu.items.length, 1);
    assertEquals(gpu.items[0].requires, { gpu: 1, vramMb: 3000 });

    const page = await client.execJson<{ items: PoolJob[]; nextCursor: number | null }>(`pool list ${path} --limit 1`);
    assertEquals(page.items.length, 1);
    assertEquals(page.nextCursor, page.items[0].id);
  });

  await t.step('a claim matches capacity, not queue order', async () => {
    // The offer covers the CPU job but not the GPU one, so the lower-priority
    // job is the right answer — this is the whole point of the pool.
    const job = await client.execJson<PoolJob>(`pool claim ${path} --owner tester --offer cpu=4`);
    assertEquals(job.kind, 'cpu-convert');
    assertEquals(job.leaseOwner, 'tester');
    assertEquals(job.attempts, 1);

    const stat = await client.execJson<Stat>(`pool stat ${path}`);
    assertEquals(stat.counts.claimed, 1);
    assertEquals(stat.backlog, 1);
  });

  await t.step('a claim with no matching capacity fails rather than blocking', async () => {
    const result = await client.exec(`pool claim ${path} --owner tester --offer cpu=4`);
    assertEquals(result.success, false);
  });

  await t.step('cat prints the backlog without consuming it', async () => {
    const first = await client.execString(`cat ${path}`);
    assertEquals(first.trim().split('\n').length, 1);
    assertEquals(JSON.parse(first.trim()).kind, 'gpu-faces');

    // Reading a queue drains it; reading a pool must not.
    const again = await client.execString(`cat ${path}`);
    assertEquals(JSON.parse(again.trim()).kind, 'gpu-faces');
  });

  await t.step('cancel, retry and purge round-trip', async () => {
    const cancelled = await client.execJson<Ok>(`pool cancel ${path} --key step-a`);
    assertEquals(cancelled.count, 1);
    assertEquals((await client.execJson<Stat>(`pool stat ${path}`)).counts.cancelled, 1);

    const retried = await client.execJson<Ok>(`pool retry ${path} --key step-a`);
    assertEquals(retried.count, 1);
    assertEquals((await client.execJson<Stat>(`pool stat ${path}`)).counts.ready, 1);

    // By kind: what clears the leftovers of a kind renamed under its queued jobs.
    const byKind = await client.execJson<Ok>(`pool cancel ${path} --kind gpu-faces`);
    assertEquals(byKind.count, 1);
    await client.exec(`pool cancel ${path} --prefix step-`);
    const purged = await client.execJson<Ok>(`pool purge ${path}`);
    assertEquals(purged.count, 2);
    // Purged jobs stay counted, so a count of finished work never falls.
    const after = (await client.execJson<Stat>(`pool stat ${path}`)).counts;
    assertEquals([after.ready, after.claimed, after.cancelled], [0, 0, 2]);
  });

  await t.step('bad input fails with a message, not a stack', async () => {
    const badVector = await client.exec(`pool add ${path} --kind a --requires gpu`);
    assertEquals(badVector.success, false);
    assertEquals((badVector.error ?? '').includes('expected key=number'), true);

    const noKind = await client.exec(`pool add ${path}`);
    assertEquals(noKind.success, false);
    assertEquals((noKind.error ?? '').includes('missing --kind'), true);

    const twoSelectors = await client.exec(`pool cancel ${path} --key a --prefix b`);
    assertEquals(twoSelectors.success, false);

    const missing = await client.exec(`pool stat ${POOLS_PATH}/nope`);
    assertEquals(missing.success, false);
  });

  await harness.stop();
});
