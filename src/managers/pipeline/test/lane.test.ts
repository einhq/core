/**
 * Lanes: work a `lane: 'bulk'` fact starts runs `LANE_OFFSET.bulk` below the normal lane's — its
 * trigger job, its instance (`lane`) and each pooled step — and a normal announcement of the same
 * subject lifts a waiting bulk trigger into the normal lane, run and all. A pool claims normal
 * work before bulk work, and aging below the gap reorders bulk work among itself only; both pool
 * registries are held to that, the PostgreSQL one in its tier.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { DomainEvent } from '../../../lib/events/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { PG_URL, pgTestContext } from '../../../testing/gates.ts';
import { MemoryPoolRegistry, type PoolJob, type PoolRegistryIf } from '../../../registries/pool/mod.ts';
import { PgPoolRegistry } from '../../../registries/pool/pg-pool-registry.ts';
import { LANE_OFFSET, type PipelineInstanceAttrs } from '../types.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const FACT = 'test.lane.happened';
const HELD_FACT = 'test.lane.held';
const POOL = `${POOLS_PATH}/lanepool`;
const TRIGGERS = `${POOLS_PATH}/triggers`;

/** A predicate that throws counts as "not yet": the nodes it reads are being created under it. */
async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch { /* not there yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'a bulk fact runs every job it starts in the bulk lane',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const define = async (name: string, lines: string[]): Promise<void> => {
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(`/work/${name}.yaml`, [`name: ${name}`, ...lines].join('\n'));
    assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true, `define ${name}`);
  };

  const emit = async (type: string, subject: string, lane?: 'bulk'): Promise<void> => {
    const event: DomainEvent = { id: crypto.randomUUID(), type, subject, time: Date.now(), source: 'lane-test', ...(lane ? { lane } : {}) };
    await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
  };

  const makeFile = async (path: string): Promise<string> => {
    await client.exec(`mknode -t file --as "name=${path.split('/').pop()}" ${path}`);
    return (await vfs.get(ADMIN_ACCESS, path)).id;
  };

  const instance = (pipeline: string, id: string) => vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${id}`);

  /** The live job in the step pool for `pipeline`'s instance `id`'s step `heavy`. */
  const stepJob = async (pipeline: string, id: string): Promise<PoolJob | undefined> => {
    const dedupKey = join(PIPELINE_INSTANCES_PATH, pipeline, id, 'steps', 'heavy');
    return (await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey }))[0];
  };

  /** The live trigger job of `pipeline` for node `id`. */
  const triggerJob = async (pipeline: string, id: string): Promise<PoolJob[]> =>
    await vfs.poolJobs(ADMIN_ACCESS, TRIGGERS, { state: ['ready', 'claimed'], dedupKey: `${pipeline}/${id}` });

  // One pooled step nothing claims, so its job stays in the pool to be read.
  const steps = ['steps:', '  heavy:', '    command: lane-never $NODE_PATH', '    pool: lanepool', '    kind: heavy', '    priority: 30'];

  try {
    await client.exec('mkdir -p /work');
    await define('test-lane', ['trigger:', `  on: ${FACT}`, ...steps]);
    // Held in the trigger pool for a while, so its jobs can be read before they become instances.
    await define('test-lane-held', ['trigger:', `  on: ${HELD_FACT}`, ...steps, 'options:', '  debounceMs: 2500']);

    await t.step('the instance of a bulk fact is in the bulk lane, and its pooled step runs the offset lower', async () => {
      const bulk = await makeFile('/work/bulk.bin');
      const normal = await makeFile('/work/normal.bin');
      await emit(FACT, '/work/bulk.bin', 'bulk');
      await emit(FACT, '/work/normal.bin');

      await waitFor(async () => (await stepJob('test-lane', bulk)) !== undefined && (await stepJob('test-lane', normal)) !== undefined, 'both steps pooled');
      assertEquals((await instance('test-lane', bulk)).attrs.lane, 'bulk');
      assertEquals((await instance('test-lane', normal)).attrs.lane, undefined);
      assertEquals((await stepJob('test-lane', bulk))?.priority, 30 + LANE_OFFSET.bulk);
      assertEquals((await stepJob('test-lane', normal))?.priority, 30);
    });

    await t.step('a bulk trigger job waits at the offset; a normal announcement lifts it, and its run is in the normal lane', async () => {
      const lifted = await makeFile('/work/lifted.bin');
      const alone = await makeFile('/work/alone.bin');
      await emit(HELD_FACT, '/work/lifted.bin', 'bulk');
      await emit(HELD_FACT, '/work/alone.bin', 'bulk');
      await waitFor(async () => (await triggerJob('test-lane-held', lifted)).length === 1 && (await triggerJob('test-lane-held', alone)).length === 1, 'both trigger jobs');
      assertEquals((await triggerJob('test-lane-held', lifted)).map((job) => job.priority), [LANE_OFFSET.bulk]);

      await emit(HELD_FACT, '/work/lifted.bin');
      await waitFor(async () => (await triggerJob('test-lane-held', lifted))[0]?.priority === 0, 'the lifted trigger job');
      assertEquals((await triggerJob('test-lane-held', alone)).map((job) => job.priority), [LANE_OFFSET.bulk]);

      await waitFor(async () => (await stepJob('test-lane-held', lifted)) !== undefined && (await stepJob('test-lane-held', alone)) !== undefined, 'both steps pooled');
      assertEquals((await instance('test-lane-held', lifted)).attrs.lane, undefined);
      assertEquals((await stepJob('test-lane-held', lifted))?.priority, 30);
      assertEquals((await instance('test-lane-held', alone)).attrs.lane, 'bulk');
      assertEquals((await stepJob('test-lane-held', alone))?.priority, 30 + LANE_OFFSET.bulk);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});

/** The order a pool gives jobs of one kind in the two lanes, each bulk job at the offset below its step's priority. */
async function claimOrder(registry: PoolRegistryIf, t: Deno.TestContext): Promise<void> {
  const claim = async (pool: string): Promise<string | undefined> => {
    const job = await registry.claim(pool, { owner: 'lane-test', kinds: ['heavy'] });
    return job ? String(job.params) : undefined;
  };
  const drain = async (pool: string): Promise<string[]> => {
    const order: string[] = [];
    for (let next = await claim(pool); next !== undefined; next = await claim(pool)) order.push(next);
    return order;
  };

  await t.step('with work of both lanes ready, every normal job is claimed before any bulk one', async () => {
    await registry.touch('lanes', {});
    // The bulk work was queued first, and its steps rank higher in their pipeline.
    await registry.add('lanes', { kind: 'heavy', priority: 100 + LANE_OFFSET.bulk, params: 'bulk-exif' });
    await registry.add('lanes', { kind: 'heavy', priority: 30 + LANE_OFFSET.bulk, params: 'bulk-faces' });
    await registry.add('lanes', { kind: 'heavy', priority: 30, params: 'upload-faces' });
    await registry.add('lanes', { kind: 'heavy', priority: 10, params: 'upload-ocr' });
    assertEquals(await drain('lanes'), ['upload-faces', 'upload-ocr', 'bulk-exif', 'bulk-faces']);
  });

  await t.step("aged bulk work is claimed before younger bulk work, and still after the same step's normal work", async () => {
    // One aging step lifts a job by 99, below the gap between a step's two lanes.
    await registry.touch('aged', { agingSeconds: 1, agingBoost: 99, agingMax: 99 });
    await registry.add('aged', { kind: 'heavy', priority: 30 + LANE_OFFSET.bulk, params: 'bulk-old' });
    await new Promise((r) => setTimeout(r, 1300));
    await registry.add('aged', { kind: 'heavy', priority: 100 + LANE_OFFSET.bulk, params: 'bulk-new' });
    await registry.add('aged', { kind: 'heavy', priority: 30, params: 'upload' });
    assertEquals((await registry.sweep('aged')).promoted, 1);
    assertEquals(await drain('aged'), ['upload', 'bulk-old', 'bulk-new']);
  });
}

Deno.test('a pool claims normal work first, and aged bulk work in its turn', async (t) => {
  const registry = new MemoryPoolRegistry();
  await registry.init();
  try {
    await claimOrder(registry, t);
  } finally {
    await registry.dispose();
  }
});

Deno.test({
  name: 'a PostgreSQL pool claims normal work first, and aged bulk work in its turn',
  ignore: !PG_URL,
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = pgTestContext();
  const registry = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });
  try {
    await registry.init();
    await claimOrder(registry, t);
  } finally {
    await registry.dispose();
    await ctx.teardown();
  }
});
