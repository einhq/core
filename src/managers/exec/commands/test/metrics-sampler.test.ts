import { assertEquals } from '@std/assert';
import { deferred } from '../../../../lib/async/deferred.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createMemoryTestVfs } from '../../../../testing/memory-vfs.ts';
import { RouterManager } from '../../../router/mod.ts';
import { sampleCandidates, startDueSeries } from '../system/metrics-sampler.ts';

const SERIES = [
  { name: 'pools', intervalMs: 15_000 },
  { name: 'nodes', intervalMs: 900_000 },
];

Deno.test('startDueSeries: a slow series does not hold the others back', async () => {
  const due = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const started: string[] = [];
  const census = deferred<void>();

  const run = (name: string): Promise<void> => {
    started.push(name);
    return name === 'nodes' ? census : Promise.resolve();
  };

  startDueSeries(SERIES, 0, due, inFlight, run);
  assertEquals(started, ['pools', 'nodes']);
  await Promise.resolve();

  // Ten minutes of 15-second ticks while the census is still scanning.
  for (let now = 15_000; now <= 600_000; now += 15_000) {
    startDueSeries(SERIES, now, due, inFlight, run);
    await Promise.resolve();
  }
  assertEquals(started.filter((name) => name === 'pools').length, 41, 'pools keeps its cadence');
  assertEquals(started.filter((name) => name === 'nodes').length, 1, 'the census is not started twice');

  census.resolve();
  await inFlight.get('nodes');
  assertEquals(inFlight.has('nodes'), false);
});

Deno.test('startDueSeries: a series that overran its interval runs again on the next tick', async () => {
  const due = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const started: string[] = [];
  const census = deferred<void>();
  const run = (name: string): Promise<void> => {
    started.push(name);
    return started.length === 1 ? census : Promise.resolve();
  };
  const nodes = [SERIES[1]];

  startDueSeries(nodes, 0, due, inFlight, run);
  startDueSeries(nodes, 1_000_000, due, inFlight, run);
  assertEquals(started.length, 1, 'still in flight');

  census.resolve();
  await inFlight.get('nodes');
  startDueSeries(nodes, 1_015_000, due, inFlight, run);
  assertEquals(started.length, 2);
});

Deno.test('sampleCandidates: the files the entry point exempts are left out of the denominator', async () => {
  const routerManager = new RouterManager();
  await routerManager.init();
  const { vfs } = await createMemoryTestVfs(routerManager);
  try {
    const photo = (attrs: Record<string, unknown> = {}) => ({ mimetype: 'image/jpeg', size: 10, ...attrs });
    await vfs.createTree(ADMIN_ACCESS, '/', [{
      type: 'directory',
      name: 'pile',
      props: { mode: 0o755 },
      children: [
        { type: 'file', name: 'a.jpg', attrs: photo() },
        { type: 'file', name: 'b.jpg', attrs: photo({ duplicate: { sha256: 'a', kind: 'exact', of: 'x', deferred: true } }) },
        { type: 'file', name: 'c.jpg', attrs: photo({ duplicate: { sha256: 'c', kind: 'exact', of: 'y' } }) },
        { type: 'file', name: 'clip.mp4', attrs: { mimetype: 'video/mp4', size: 10, duplicate: { sha256: 'v', deferred: true } } },
        { type: 'file', name: 'a.webp', attrs: photo({ mimetype: 'image/webp', sourceId: 'a' }) },
      ],
    }]);
    assertEquals(await sampleCandidates(vfs, { kinds: ['photo', 'video'] }), 4);
    assertEquals(await sampleCandidates(vfs, { kinds: ['photo', 'video'], exempt: 'duplicate.deferred' }), 2);
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
  }
});
