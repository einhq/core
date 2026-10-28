import { assertEquals } from '@std/assert';
import { cpuPercent, downsample, eta, hostCpuPercent, percent, rate, within } from '../derive.ts';
import { parseProcStat } from '../host.ts';
import type { Sample } from '../types.ts';

const at = (minutes: number) => Date.now() - (60 - minutes) * 60_000;

const counters = (values: number[]): Sample<{ n: number }>[] => values.map((n, i) => ({ at: at(i * 10), value: { n } }));

Deno.test('rate: counter over the widest available span', () => {
  // 0 -> 300 over 30 minutes = 10 per minute.
  const samples = counters([0, 100, 200, 300]);
  const perMs = rate(samples, (entry) => entry.n);
  assertEquals(Math.round((perMs ?? 0) * 60_000), 10);
});

Deno.test('rate: a single sample has no rate', () => {
  assertEquals(rate(counters([5]), (entry) => entry.n), undefined);
});

Deno.test('rate: refuses spans shorter than a minute', () => {
  const now = Date.now();
  const samples: Sample<{ n: number }>[] = [
    { at: now - 15_000, value: { n: 0 } },
    { at: now, value: { n: 50 } },
  ];
  assertEquals(rate(samples, (entry) => entry.n), undefined);
});

Deno.test('rate: a counter that went backwards yields nothing', () => {
  // What `pool-purge` does to `done`, and a restart does to usage_usec. A
  // negative rate here would put a negative ETA on the dashboard.
  assertEquals(rate(counters([500, 200]), (entry) => entry.n), undefined);
});

Deno.test('rate: measures from after a reset, not across it', () => {
  // 0 -> 900 -> 5 -> 65 ends above where it started, so endpoints alone would
  // report 65 units of progress and a wildly long ETA. Only the 5 -> 65 stretch
  // after the purge is real: 60 over the 10 minutes between those samples.
  const perMs = rate(counters([0, 900, 5, 65]), (entry) => entry.n);
  assertEquals(Math.round((perMs ?? 0) * 60_000), 6);
});

Deno.test('rate: a reset with too little history after it yields nothing', () => {
  const now = Date.now();
  const samples: Sample<{ n: number }>[] = [
    { at: now - 3_600_000, value: { n: 0 } },
    { at: now - 1_800_000, value: { n: 900 } },
    // Purged 15s ago: not enough span since to measure anything.
    { at: now - 15_000, value: { n: 2 } },
    { at: now, value: { n: 9 } },
  ];
  assertEquals(rate(samples, (entry) => entry.n), undefined);
});

Deno.test('rate: skips entries missing the field', () => {
  const now = Date.now();
  const samples: Sample<Record<string, number>>[] = [
    { at: now - 3_600_000, value: {} },
    { at: now - 1_800_000, value: { pool: 100 } },
    { at: now, value: { pool: 400 } },
  ];
  const perMs = rate(samples, (entry) => entry.pool);
  assertEquals(Math.round((perMs ?? 0) * 3_600_000), 600);
});

Deno.test('cpuPercent: one saturated core out of four is 25%', () => {
  const now = Date.now();
  const samples: Sample<{ usageUsec: number; cores: number }>[] = [
    { at: now - 120_000, value: { usageUsec: 0, cores: 4 } },
    // 120s of wall clock, 120s of CPU consumed = exactly one core busy.
    { at: now, value: { usageUsec: 120_000_000, cores: 4 } },
  ];
  assertEquals(cpuPercent(samples), 25);
});

Deno.test('cpuPercent: reports from two consecutive samples', () => {
  // Consecutive samples are one 15s interval apart and every "current" reading
  // is exactly this pair, so CPU must be measurable over it.
  const now = Date.now();
  const samples: Sample<{ usageUsec: number; cores: number }>[] = [
    { at: now - 15_000, value: { usageUsec: 0, cores: 4 } },
    { at: now, value: { usageUsec: 30_000_000, cores: 4 } },
  ];
  // 30s of CPU over 15s of wall clock on 4 cores = two cores busy = 50%.
  assertEquals(cpuPercent(samples), 50);
});

Deno.test('rate: still holds throughput to the wider floor', () => {
  // The same 15s span must remain unreportable for a job counter, where one
  // job in the window would read as 240/hour.
  const now = Date.now();
  const samples: Sample<{ n: number }>[] = [
    { at: now - 15_000, value: { n: 0 } },
    { at: now, value: { n: 1 } },
  ];
  assertEquals(rate(samples, (entry) => entry.n), undefined);
});

Deno.test('cpuPercent: clamps above 100', () => {
  const now = Date.now();
  const samples: Sample<{ usageUsec: number; cores: number }>[] = [
    { at: now - 120_000, value: { usageUsec: 0, cores: 2 } },
    { at: now, value: { usageUsec: 999_000_000, cores: 2 } },
  ];
  assertEquals(cpuPercent(samples), 100);
});

Deno.test('percent: guards a zero or missing total', () => {
  assertEquals(percent(5, 10), 50);
  assertEquals(percent(5, 0), undefined);
  assertEquals(percent(5, undefined), undefined);
});

Deno.test('eta: nothing to do and nothing being done both yield nothing', () => {
  assertEquals(eta(0, 1), undefined);
  assertEquals(eta(100, 0), undefined);
  assertEquals(eta(100, undefined), undefined);
  // 100 units at 1 per second.
  assertEquals(eta(100, 1 / 1000), 100_000);
});

Deno.test('downsample: keeps the newest sample', () => {
  const samples: Sample<number>[] = Array.from({ length: 500 }, (_, i) => ({ at: i, value: i }));
  const thinned = downsample(samples, 10);

  assertEquals(thinned.length, 10);
  assertEquals(thinned[0].value, 0);
  assertEquals(thinned[thinned.length - 1].value, 499);
});

Deno.test('downsample: a short series is returned whole', () => {
  const samples: Sample<number>[] = [{ at: 1, value: 1 }, { at: 2, value: 2 }];
  assertEquals(downsample(samples, 10), samples);
});

Deno.test('within: drops samples older than the window', () => {
  const now = Date.now();
  const samples: Sample<number>[] = [
    { at: now - 7_200_000, value: 1 },
    { at: now - 60_000, value: 2 },
  ];
  assertEquals(within(samples, 3_600_000).map((sample) => sample.value), [2]);
});

Deno.test('parseProcStat: idle and iowait are the only time not busy', () => {
  const text = 'cpu  100 20 30 400 50 6 4 0 0 0\ncpu0 50 10 15 200 25 3 2 0 0 0\nintr 1\n';
  assertEquals(parseProcStat(text), { busy: 160, total: 610 });
  assertEquals(parseProcStat('intr 1\n'), undefined);
});

Deno.test('hostCpuPercent: busy ticks over all ticks between the first and last sample', () => {
  const now = Date.now();
  const samples = [
    { at: now - 15_000, value: { host: { busy: 1000, total: 2000 } } },
    { at: now, value: { host: { busy: 1450, total: 2600 } } },
  ];
  assertEquals(hostCpuPercent(samples), 75);
});

Deno.test('hostCpuPercent: nothing from a sample without the host counters, or across a reboot', () => {
  const now = Date.now();
  assertEquals(hostCpuPercent([{ at: now - 15_000, value: {} }, { at: now, value: { host: { busy: 10, total: 20 } } }]), undefined);
  assertEquals(hostCpuPercent([{ at: now - 15_000, value: { host: { busy: 900, total: 2000 } } }, { at: now, value: { host: { busy: 10, total: 20 } } }]), undefined);
});
