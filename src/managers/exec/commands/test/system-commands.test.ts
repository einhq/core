/**
 * The commands the system dashboard and `top` are built from, read the way a shell would read
 * them: host-metrics, df, system-info, pool-stat, pipeline-overview's rates and coverage, dmesg.
 *
 * The point of most of these is degradation. They run on a laptop with no GPU, in a test harness
 * with no cgroup, and on a freshly booted instance where metrics-sampler has not ticked yet — and
 * the dashboard has to render in all three. So the contract is that absent sources produce absent
 * fields, not zeroes and not exceptions. No sampler runs here, so every sample is written by hand.
 */

import { METRICS_PATH, POOLS_PATH } from '../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { METRICS_SERIES, seriesPath } from '../../../../lib/metrics/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import type { DiskUsage, HostMetrics, LogLine, PoolStatAnswer, SystemInfo } from '../../../../lib/api/system.ts';
import type { PipelineOverview } from '../../../../lib/api/pipeline.ts';
import { UNSERVABLE_GRACE_MS, unservableKinds } from '../../../pipeline/unservable.ts';
import { MODULE_API_VERSION } from '../../../../modules/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

const HALF_HOUR_AGO = () => new Date(Date.now() - 1_800_000).toISOString();

Deno.test({
  name: 'system commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('every command answers before the sampler has ever run', async () => {
      const host = await client.execJson<HostMetrics>('host-metrics');
      assertEquals(host.sampled, false);

      const disk = await client.execJson<DiskUsage>('df');
      assertEquals(disk.tiers, []);

      const info = await client.execJson<SystemInfo>('system-info');
      assertEquals(typeof info.denoVersion, 'string');
      assertEquals(info.uptimeMs >= 0, true);
      assertEquals(info.api, MODULE_API_VERSION);
      assertEquals(typeof info.version, 'string');

      const overview = await client.execJson<PipelineOverview>('pipeline-overview');
      assertEquals(overview.coverage, undefined);
    });

    await cmd.shouldSucceed(`mkdir -p ${METRICS_PATH}`);
    for (const series of ['memory', 'disk', 'pools', 'pipelines', 'nodes'] as const) {
      await cmd.shouldSucceed(`mknode -t log ${seriesPath(series)}`);
    }

    await t.step('host-metrics picks up a series once it has entries', async () => {
      await cmd.shouldSucceed(`log-append ${seriesPath('memory')} --data '{"usedBytes":1073741824,"limitBytes":4294967296}'`);

      const host = await client.execJson<HostMetrics>('host-metrics');
      assertEquals(host.sampled, true);
      assertEquals(host.memory?.percent, 25);
      assertEquals(host.cpu, undefined);
    });

    await t.step("host-metrics reports the event loop's lag once the runtime series has entries", async () => {
      await cmd.shouldSucceed(`mknode -t log ${seriesPath('runtime')}`);
      await cmd.shouldSucceed(`log-append ${seriesPath('runtime')} --data '{"lag":{"maxMs":12.5,"meanMs":1.2,"p99Ms":4.5,"samples":150}}'`);

      const host = await client.execJson<HostMetrics>('host-metrics --window 10');
      assertEquals(host.lag?.p99Ms, 4.5);
      assertEquals(host.lag?.maxMs, 12.5);
      assertEquals(host.lag?.series.map((point) => point.value), [4.5]);
    });

    await t.step('df projects when a growing tier fills', async () => {
      // 1 GiB written in half an hour is 48 GiB a day; 96 GiB free lasts two days.
      const GiB = 1024 ** 3;
      const tier = (free: number) => `[{"tier":"disk","path":"/files","device":"/dev/sda1","totalBytes":${200 * GiB},"freeBytes":${free}}]`;
      await cmd.shouldSucceed(`log-append ${seriesPath('disk')} --data '${tier(97 * GiB)}' --at ${HALF_HOUR_AGO()}`);
      await cmd.shouldSucceed(`log-append ${seriesPath('disk')} --data '${tier(96 * GiB)}'`);

      const disk = await client.execJson<DiskUsage>('df');
      assertEquals(disk.tiers.length, 1);
      assertEquals(disk.tiers[0].usedPercent, 52);
      assertEquals(disk.tiers[0].daysUntilFull, 2);
    });

    const pool = `${POOLS_PATH}/rates`;

    await t.step('pool-stat derives rates from the series and counts from the pool', async () => {
      await cmd.shouldSucceed(`mkdir -p ${POOLS_PATH}`);
      await cmd.shouldSucceed(`mkpool ${pool}`);
      for (let i = 0; i < 3; i++) await cmd.shouldSucceed(`pool add ${pool} --kind gpu-faces --key faces-${i}`);
      for (let i = 0; i < 2; i++) await cmd.shouldSucceed(`pool add ${pool} --kind gpu-describe --key describe-${i}`);

      // Two readings half an hour apart: 300 jobs done is 600/h for the pool, and 100 of each
      // kind is 200/h a kind. Well inside the one-hour rate window — a sample backdated to
      // exactly its edge falls out of it while the test is running.
      const sample = (done: number, perKind: number) =>
        `{"rates":{"ready":5,"claimed":0,"done":${done},"failed":0,"byKind":{` +
        `"gpu-faces":{"ready":3,"claimed":0,"done":${perKind},"failed":0},` +
        `"gpu-describe":{"ready":2,"claimed":0,"done":${perKind},"failed":0}}}}`;
      await cmd.shouldSucceed(`log-append ${seriesPath('pools')} --data '${sample(0, 0)}' --at ${HALF_HOUR_AGO()}`);
      await cmd.shouldSucceed(`log-append ${seriesPath('pools')} --data '${sample(300, 100)}'`);

      const stat = await client.execJson<PoolStatAnswer>(`pool-stat ${pool}`);
      assertEquals(stat.name, 'rates');
      assertEquals(stat.role, 'work');
      assertEquals(stat.backlog, 5);
      assertEquals(stat.ready, 5);
      assertEquals(stat.perHour, 600);
      assertEquals(Array.isArray(stat.workers), true);

      const faces = stat.kinds?.find((kind) => kind.kind === 'gpu-faces');
      assertEquals(faces?.ready, 3);
      assertEquals(faces?.perHour, 200);
      // 3 left at 200/h is 54 s, allowing for the wall clock moving during the test.
      const seconds = (faces?.etaMs ?? 0) / 1000;
      assertEquals(seconds > 50 && seconds < 58, true, `eta ${seconds}s`);

      // Without a path it is every pool, the same shape.
      const all = await client.execJson<PoolStatAnswer[]>('pool-stat');
      assertEquals(all.find((entry) => entry.name === 'rates')?.perHour, 600);
    });

    await t.step('pool-stat marks a kind no worker offers, and gives it no ETA', async () => {
      // A kind renamed under its queued jobs: the old kind still has a rate from before the
      // rename, but no ETA is computed for a backlog nothing will ever claim.
      //
      // What the sampler does on its pools tick, with the first sighting backdated past the
      // grace: the process singleton is the one pool-stat reads.
      const since = Date.now() - 2 * UNSERVABLE_GRACE_MS;
      unservableKinds.observe(
        POOLS_PATH,
        { rates: { byKind: { 'gpu-describe': { ready: 2 }, 'gpu-faces': { ready: 3 } } } },
        [{ pool, owner: 'test', kinds: ['gpu-faces'], kindQuantumMs: 0, concurrency: 1, reserveKinds: [], reserveCapacity: {}, resting: {} }],
        since,
      );

      try {
        const stat = await client.execJson<PoolStatAnswer>(`pool-stat ${pool}`);
        const describe = stat.kinds?.find((kind) => kind.kind === 'gpu-describe');
        const faces = stat.kinds?.find((kind) => kind.kind === 'gpu-faces');

        assertEquals(describe?.unservableSince, since);
        assertEquals(describe?.perHour, 200, 'the leftover rate is still reported — it is a fact');
        assertEquals(describe?.etaMs, undefined, 'but nothing is estimated from it');
        assertEquals(faces?.unservableSince, undefined);
        assertEquals(faces?.etaMs !== undefined, true);
        assertEquals(stat.etaMs, faces?.etaMs, 'the pool ETA is the servable kind, not the longer unservable one');

        const text = await client.execString('export JSON_OUTPUT=0\npool-stat | grep gpu-describe');
        assertEquals(text.includes('NO WORKER offers this kind'), true, text);
      } finally {
        unservableKinds.observe(POOLS_PATH, {}, []);
      }
    });

    await t.step('pool-stat reports no rate when the counter went backwards', async () => {
      // What a pool-purge looks like from here. An ETA computed off a negative
      // rate would count down into the past.
      await cmd.shouldSucceed(`log-append ${seriesPath('pools')} --data '{"rates":{"ready":5,"claimed":0,"done":5,"failed":0}}'`);

      const stat = await client.execJson<PoolStatAnswer>(`pool-stat ${pool}`);
      assertEquals(stat.perHour, undefined);
    });

    await t.step('pipeline-overview carries what each pipeline finishes per hour', async () => {
      // A node that looks like an instance to the aggregate is enough for the row to exist.
      await cmd.shouldSucceed('mkdir -p /tmp/rates-instance && attrs -s pipelineName=rates-pipe -s status=completed /tmp/rates-instance');
      await cmd.shouldSucceed(`log-append ${seriesPath('pipelines')} --data '{"completed":{"rates-pipe":10}}' --at ${HALF_HOUR_AGO()}`);
      await cmd.shouldSucceed(`log-append ${seriesPath('pipelines')} --data '{"completed":{"rates-pipe":20}}'`);

      const overview = await client.execJson<PipelineOverview>('pipeline-overview');
      assertEquals(overview.instances.byPipeline.find((row) => row.pipeline === 'rates-pipe')?.completedPerHour, 20);
    });

    await t.step('pipeline-overview measures crawl coverage as marker nodes against candidate files', async () => {
      // 25 photos and videos in the library, 10 of them carrying the marker the
      // entry pipeline creates. Both sides are node counts: an instance count
      // would sit at whatever pipeline-pruner's cap happens to be.
      // The entry pipeline names itself in the sample; nothing in core knows it.
      const coverage = (covered: number) =>
        `{"byType":{"file":40,"exif":${covered}},"derivedFiles":15,` +
        `"coverage":{"pipeline":"ingest","marker":"exif","kinds":["photo","video"],"covered":${covered},"candidates":25}}`;

      await cmd.shouldSucceed(`log-append ${seriesPath('nodes')} --data '${coverage(5)}' --at ${HALF_HOUR_AGO()}`);
      await cmd.shouldSucceed(`log-append ${seriesPath('nodes')} --data '${coverage(10)}'`);

      const { coverage: crawl } = await client.execJson<PipelineOverview>('pipeline-overview');
      assertEquals(crawl?.pipeline, 'ingest');
      assertEquals(crawl?.kinds, ['photo', 'video']);
      assertEquals(crawl?.candidates, 25);
      assertEquals(crawl?.covered, 10);
      assertEquals(crawl?.remaining, 15);
      assertEquals(crawl?.perHour, 10);
    });

    await t.step('no coverage when nothing declares how to measure it', async () => {
      // A core-only install has no media module and therefore no crawl; so does
      // an entry point that declares itself but not its kinds and marker.
      await cmd.shouldSucceed(`log-append ${seriesPath('nodes')} --data '{"byType":{"file":40},"derivedFiles":15}'`);

      const overview = await client.execJson<PipelineOverview>('pipeline-overview');
      assertEquals(overview.coverage, undefined);
    });

    await t.step('dmesg --level keeps that level and above, before -n counts', async () => {
      const log = '/tmp/levels.log';
      await cmd.shouldSucceed(`mknode -t log ${log}`);
      for (const [level, message] of [['WARN', 'first'], ['INFO', 'chatter'], ['ERROR', 'second'], ['INFO', 'more chatter']]) {
        await cmd.shouldSucceed(`log-append ${log} --data '{"level":"${level}","name":"test","message":"${message}","timestamp":"2026-01-01 12:00:00"}'`);
      }

      const problems = await client.execJson<LogLine[]>(`dmesg ${log} --level warn`);
      assertEquals(problems.map((line) => line.message), ['first', 'second']);

      // The last problem, not the problems among the last line.
      const last = await client.execJson<LogLine[]>(`dmesg ${log} --level warn -n 1`);
      assertEquals(last.map((line) => line.message), ['second']);

      await cmd.shouldFailWith(`dmesg ${log} --level loud`, '--level must be one of');
    });

    await t.step('dmesg -n reads a long log from its end, as far back as the matching lines are', async () => {
      // Further back than one window from the end: the problems are lines 10 and 20 of 2500.
      const log = '/tmp/long.log';
      await cmd.shouldSucceed(`mknode -t log ${log}`);
      await cmd.shouldSucceed(
        `for i in $(seq 2500); do if [ $i -eq 10 ] || [ $i -eq 20 ]; then level=WARN; else level=INFO; fi; ` +
          `echo "{\\"level\\":\\"$level\\",\\"name\\":\\"test\\",\\"message\\":\\"line $i\\"}"; done >> ${log}`,
      );

      const last = await client.execJson<LogLine[]>(`dmesg ${log} -n 3`);
      assertEquals(last.map((line) => line.message), ['line 2498', 'line 2499', 'line 2500']);

      const problems = await client.execJson<LogLine[]>(`dmesg ${log} --level warn -n 5`);
      assertEquals(problems.map((line) => line.message), ['line 10', 'line 20']);

      const newest = await client.execJson<LogLine[]>(`dmesg ${log} --level warn -n 1`);
      assertEquals(newest.map((line) => line.message), ['line 20']);

      assertEquals(await client.execJson<LogLine[]>(`dmesg ${log} -n 0`), []);
    });

    await t.step(`every declared series has a distinct path under ${METRICS_PATH}`, () => {
      const paths = new Set(METRICS_SERIES.map((series) => seriesPath(series.name)));
      assertEquals(paths.size, METRICS_SERIES.length);
      for (const path of paths) assertEquals(path.startsWith(`${METRICS_PATH}/`), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
