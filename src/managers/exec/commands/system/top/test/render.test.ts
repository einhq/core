import { assert, assertEquals } from '@std/assert';
import { VirtualTerminal } from '../../../../../shell/terminal/test/virtual-terminal.ts';
import { rowWidth, toAnsi, toText } from '../draw.ts';
import { cpuColumns, renderTop, type TopView } from '../render.ts';
import type { TopData } from '../sources.ts';

const NOW = Date.parse('2026-03-14T12:00:00Z');
const GiB = 1024 ** 3;

const view = (overrides: Partial<TopView> = {}): TopView => ({ sort: 'newest', scroll: 0, tickMs: 2000, paused: false, ...overrides });

/** Nothing read yet: what the first frame is drawn from. */
const empty = (): TopData => ({
  info: { hostname: 'laptop', version: '0.1.0', api: '36.4.0', denoVersion: '2.0.0', uptimeMs: 60_000 },
  cpu: [],
  heap: { usedBytes: 100 * 1024 ** 2, limitBytes: 4 * GiB },
  errors: {},
});

const process = (name: string, args: string[], user: string, origin: 'ssh' | 'service' | 'web', agoMs: number) => ({
  pid: `${name}-01J0000000000000000000${agoMs}`,
  name,
  args,
  uid: user === 'admin' ? 0 : 1002,
  user,
  tty: `tty-01J00000000000000000000${origin.slice(0, 2).toUpperCase()}`,
  origin,
  service: origin === 'service' ? 'pipeline-engine' : undefined,
  startedAt: NOW - agoMs,
  foreground: true,
  cwd: '/',
});

/** A busy instance, invented. */
const sample = (): TopData => ({
  info: { hostname: 'testhost', version: '0.1.0', api: '36.4.0', denoVersion: '2.0.0', uptimeMs: 3 * 86_400_000 },
  load: [3.5, 2.9, 2.1],
  cores: 4,
  cpu: Array.from({ length: 300 }, (_, i) => ({ at: NOW - (300 - i) * 2000, value: 50 + 45 * Math.sin(i / 7) })),
  memory: { usedBytes: 6 * GiB, limitBytes: 8 * GiB },
  heap: { usedBytes: 300 * 1024 ** 2, limitBytes: 4 * GiB },
  host: { sampled: true, lag: { p99Ms: 4.2, maxMs: 120, series: [] } },
  disk: {
    tiers: [
      { tier: 'disk', path: '/files', device: '/dev/a', totalBytes: 2000 * GiB, freeBytes: 900 * GiB, usedPercent: 55, daysUntilFull: 200 },
      { tier: 'volatile', path: '/vol', device: '/dev/b', totalBytes: 500 * GiB, freeBytes: 20 * GiB, usedPercent: 96, daysUntilFull: 3 },
    ],
    databaseBytes: 40 * GiB,
  },
  work: {
    instances: { total: 5000, byStatus: { running: 7, queued: 1200, completed: 3780, failed: 10, cancelled: 3 }, byPipeline: [] },
    steps: { byStatus: {} },
    queues: [],
    active: [
      { pipeline: 'thumbnail', id: 'a', path: '/a', triggerPath: '/archive/albums/a-sailboat/IMG_0001.jpg', startedAt: NOW - 9000, executingSince: NOW - 5000 },
      { pipeline: 'caption', id: 'b', path: '/b', triggerPath: '/archive/albums/garden/IMG_0002.jpg', startedAt: NOW - 90_000, executingSince: NOW - 80_000 },
    ],
    quiet: [],
    quietMs: 1_800_000,
    completions: [{ at: NOW - 600_000, count: 321 }],
    memory: { heapUsedMb: 300, heapTotalMb: 400, rssMb: 900 },
  },
  pools: [{
    name: 'media',
    path: '/pools/media',
    role: 'work',
    ready: 1200,
    claimed: 3,
    done: 100,
    failed: 0,
    perHour: 400,
    etaMs: 3 * 3_600_000,
    kinds: [{ kind: 'transcode', ready: 12, claimed: 0, done: 0, failed: 0, unservableSince: NOW - 900_000 }],
    workers: [],
    backlog: 1200,
    counts: { ready: 1200, claimed: 3, done: 100, failed: 0, cancelled: 0, total: 1303 },
    policy: { agingSeconds: 0, agingBoost: 0, agingMax: 0, leaseMs: 0, maxAttempts: 0, backoffMs: 0, backoffMaxMs: 0, sweepIntervalMs: 0 },
  }],
  gauges: [{ label: 'VRAM', percent: 62, value: '10.1/16.3 GB', service: 'gpu-sampler' }],
  services: [
    { name: 'http-server', status: 'running', enabled: true, description: '', restartCount: 0, startedAt: NOW - 86_400_000 },
    { name: 'pipeline-engine', status: 'running', enabled: true, description: '', restartCount: 1, startedAt: NOW - 3_600_000, detail: '7 steps running' },
    { name: 'archive-bridge', status: 'failed', enabled: true, description: '', restartCount: 4 },
  ],
  processes: [
    process('http-server', [], 'admin', 'service', 86_400_000),
    process('media-thumbnail', ['/archive/albums/a-sailboat/IMG_0001.jpg'], 'admin', 'service', 5000),
    process('top', [], 'anna', 'ssh', 30_000),
    process('ls', ['-l', 'a name with spaces'], 'anna', 'web', 100),
  ],
  sessions: [
    { tty: 'tty-01J00000000000000000000SS', origin: 'ssh', uid: 1002, user: 'anna', since: NOW - 600_000, activeAt: NOW - 1000, cwd: '/', command: 'top' },
    { tty: 'tty-01J00000000000000000000WE', origin: 'web', uid: 1001, user: 'guest', since: NOW - 60_000, activeAt: NOW - 50_000, cwd: '/' },
  ],
  problems: [
    { timestamp: '2026-03-14T11:58:00.000Z', level: 'WARN', name: 'pool-worker', message: 'a lease expired and the job went back', extra: '' },
    { timestamp: '2026-03-14T11:59:00.000Z', level: 'ERROR', name: 'archive-bridge', message: 'connection refused', extra: '' },
  ],
  errors: {},
});

const SIZES: [number, number][] = [[1, 1], [3, 20], [8, 40], [12, 50], [24, 80], [30, 100], [40, 109], [40, 120], [60, 200], [24, 300]];

Deno.test('top frame', async (t) => {
  await t.step('fills the terminal exactly at every size, with or without data', () => {
    for (const data of [empty(), sample()]) {
      for (const [rows, cols] of SIZES) {
        const frame = renderTop(data, view(), { rows, cols }, { keys: true, now: NOW });
        assertEquals(frame.rows.length, rows, `${rows}x${cols}`);
        frame.rows.forEach((row, i) => {
          // The line of keys stops a column short of the bottom right cell.
          const width = i === rows - 1 && rows > 1 ? cols - 1 : cols;
          assertEquals(rowWidth(row), width, `${rows}x${cols} row ${i}: ${toText(row)}`);
        });
      }
    }
  });

  await t.step('lands on a terminal where its text says, colors and all', () => {
    const [rows, cols] = [40, 120];
    const frame = renderTop(sample(), view(), { rows, cols }, { keys: true, now: NOW });
    const terminal = new VirtualTerminal(rows, cols);
    terminal.write(frame.rows.map((row, i) => `\x1b[${i + 1};1H${toAnsi(row)}`).join(''));
    frame.rows.forEach((row, i) => assertEquals(terminal.line(i), toText(row).trimEnd()));
  });

  await t.step('shows every panel on a large terminal', () => {
    const text = renderTop(sample(), view(), { rows: 50, cols: 160 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    for (const title of ['CPU', 'Memory', 'Disk', 'Work', 'Sessions', 'Processes', 'Services', 'Problems']) {
      assert(text.includes(`─ ${title} `), `${title} missing:\n${text}`);
    }
    assert(text.startsWith(' EiN top   testhost · up 3d 0h · 1 user · load 3.50 2.90 2.10'), text.split('\n')[0]);
    // The verdict, then what is not fine: a kind no worker offers is what a person has to see.
    assert(text.includes('needs a person: 1 check failed'), text);
    assert(text.includes('▲ kind transcode  12 waiting, and no worker offers this kind'), text);
    // A service's gauge beside the host's.
    assert(/VRAM .* 62% {2}10\.1\/16\.3 GB/.test(text), text);
    assert(text.includes("ls -l 'a name with spaces'"), 'arguments are quoted as they would be typed');
  });

  await t.step('leaves the least important panels out of a small terminal', () => {
    const text = renderTop(sample(), view(), { rows: 24, cols: 80 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    for (const title of ['CPU', 'Memory', 'Disk', 'Work', 'Processes']) assert(text.includes(`─ ${title} `), `${title} missing:\n${text}`);
    assert(!text.includes('─ Problems '), text);
  });

  await t.step('warns of a tier about to fill on its frame when its line has no room to', () => {
    const narrow = renderTop(sample(), view(), { rows: 24, cols: 80 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    assert(narrow.includes('volatile full ~3d ─╯'), narrow);
    const wide = renderTop(sample(), view(), { rows: 50, cols: 160 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    assert(wide.includes('20.0 GB free · full ~3d'), wide);
  });

  await t.step("draws the sampler's readings before the first of its own, each over the ticks it spans", () => {
    const history = [{ at: 0, value: 10 }, { at: 15_000, value: 20 }, { at: 30_000, value: 30 }, { at: 45_000, value: 40 }];
    // 15 s of history is 7.5 ticks of 2 s: 8 columns a reading after the first; then the live ones.
    assertEquals(cpuColumns([{ at: 40_000, value: 90 }], history, 2000), [10, ...Array(8).fill(20), ...Array(8).fill(30), 90]);
    assertEquals(cpuColumns([], history, 2000).length, 1 + 3 * 8, 'with no readings of its own, all of the history');

    const data = empty();
    data.cores = 4;
    data.host = { sampled: true, cpu: { cores: 4, percent: 60, series: history.map((point) => ({ ...point, value: 60 })) } };
    const text = renderTop(data, view(), { rows: 24, cols: 80 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    assert(text.includes('60% of 4 cores'), text);
    assert(text.includes('█'), 'the graph is drawn before any reading of its own');
  });

  await t.step('gives tiers on one filesystem one meter, named for all of them', () => {
    const data = sample();
    const [disk] = data.disk!.tiers;
    data.disk!.tiers = [disk, { ...disk, tier: 'tmp', path: '/tmp' }];
    const text = renderTop(data, view(), { rows: 50, cols: 160 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    assert(text.includes('disk/tmp '), text);
    assertEquals(text.split('900 GB free').length - 1, 1, 'one number, said once');
  });

  await t.step('scrolls the process list no further than its end, and says where it is', () => {
    const data = sample();
    data.processes = Array.from({ length: 40 }, (_, i) => process(`cmd${String(i).padStart(2, '0')}`, [], 'admin', 'ssh', (i + 1) * 1000));
    const frame = renderTop(data, view({ scroll: 1000 }), { rows: 24, cols: 80 }, { keys: true, now: NOW });
    assertEquals(frame.scroll, 40 - frame.page);
    const text = frame.rows.map(toText).join('\n');
    assert(text.includes(`${40 - frame.page + 1}–40 of 40`), text);
    assert(text.includes('cmd39'), 'the oldest is last when the newest come first');
  });

  await t.step('sorts the process list as asked', () => {
    // Each row found by its time and command, which nothing else on the frame shows together.
    const rows = (sort: TopView['sort']) => {
      const text = renderTop(sample(), view({ sort }), { rows: 50, cols: 160 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
      return ['1d00h  http-server', '5s  media-thumbnail', '0s  ls', '30s  top'].map((row) => text.indexOf(row));
    };
    const [server, thumbnail, ls, top] = rows('newest');
    assert(server >= 0 && thumbnail >= 0 && ls >= 0 && top >= 0);
    assert(ls < thumbnail && thumbnail < top && top < server);
    const oldest = rows('oldest');
    assert(oldest[0] < oldest[3] && oldest[3] < oldest[1] && oldest[1] < oldest[2]);
  });

  await t.step('says what it is waiting for, and why a read failed', () => {
    const data = empty();
    data.errors.disk = 'permission denied';
    const text = renderTop(data, view(), { rows: 40, cols: 120 }, { keys: true, now: NOW }).rows.map(toText).join('\n');
    assert(text.includes('cannot read: permission denied'), text);
    assert(text.includes('reading…'), text);
    assert(text.includes('no CPU counter on this host'), text);
  });
});
