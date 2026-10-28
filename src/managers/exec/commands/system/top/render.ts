/**
 * `top`'s frame for a terminal of a given size: a header line, the panels laid out in what is
 * between, and a line of keys at the bottom.
 *
 * Panels are laid out in bands from top to bottom. A band is one column of stacked panels, or two
 * side by side on a wide terminal, and each panel says how few rows it can make do with and how
 * many it would use. Every band gets its fewest first and then, in order of importance, its most;
 * what is left goes to the process list. When even the fewest do not fit, the least important
 * bands are left out, so a small terminal keeps the CPU and memory and drops the log.
 */

import { GUEST_UID } from '../../../../../lib/access/mod.ts';
import type { HealthAnswer, HostMetrics, MetricPoint, ProcessEntry, ServiceEntry, ShellOrigin, StorageTier } from '../../../../../lib/api/system.ts';
import { cut, textWidth } from '../../../../shell/terminal/width.ts';
import { fmtAge, fmtBytes, fmtTty } from '../lib.ts';
import { labelLine, quoteWord } from '../ps.ts';
import { assessHealth } from '../health.ts';
import { formatUptime } from '../system-info.ts';
import { areaGraph, bandStyle, box, boxInner, cutStart, fit, gauge, heatStyle, padEnd, padStart, type Row, rowWidth, span, spread, STYLE } from './draw.ts';
import type { TopData } from './sources.ts';

export const PROCESS_SORTS = ['newest', 'oldest', 'user', 'command'] as const;

type ProcessSort = typeof PROCESS_SORTS[number];

/** What the person looking has chosen. */
export type TopView = {
  sort: ProcessSort;
  /** Process rows scrolled past. */
  scroll: number;
  tickMs: number;
  paused: boolean;
};

type TopFrame = {
  rows: Row[];
  /** Process rows the list had room for, for paging. */
  page: number;
  /** The scroll the list was drawn at, brought within range. */
  scroll: number;
};

type Panel = {
  /** Rows, the frame's included. */
  min: number;
  want: number;
  /** Takes the rows left once every panel has what it wants. */
  grow?: boolean;
  draw: (width: number, height: number) => Row[];
};

/** One or two columns of panels, stacked; a lower `rank` is more important. */
type Band = { rank: number; columns: { width: number; panels: Panel[] }[] };

/** Where the process list leaves its page size and scroll while it is drawn. */
type ListState = { page: number; scroll: number };

/** Columns from which the panels go two abreast. */
const WIDE = 110;

/** Columns from which two small panels share a band. */
const PAIRED = 72;

const SEPARATOR = span(' · ', STYLE.dim);

const ORIGIN_STYLE: Record<ShellOrigin, string> = {
  ssh: '38;5;117',
  'ssh-exec': '38;5;117',
  terminal: '38;5;111',
  web: '38;5;176',
  service: STYLE.dim,
  system: STYLE.dim,
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const count = (value: number): string => value.toLocaleString('en-US');

/** `14:02:31`, in the server's time zone. */
const clock = (at: number): string => new Date(at).toTimeString().slice(0, 8);

/** `0.8 ms`, `45 ms`, `1.2 s`. */
const fmtMs = (ms: number): string => ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** `42m`, `14.8h`, `3.2d`: how long a backlog lasts. */
const fmtEta = (ms: number): string => {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
};

const VERDICT_STYLE: Record<HealthAnswer['verdict'], string> = {
  healthy: STYLE.ok,
  'catching-up': STYLE.running,
  stuck: STYLE.warn,
  'needs-person': STYLE.bad,
};

/** Days to full below which a tier's projection is a warning, as on the dashboard. */
const URGENT_DAYS = 14;

/** Loop lag in the same three steps: a stall under 50 ms goes unnoticed, past 200 ms a keystroke waits. */
const lagStyle = (ms: number): string => ms >= 200 ? STYLE.bad : ms >= 50 ? STYLE.warn : STYLE.ok;

const dimRow = (text: string): Row => [span(text, STYLE.dim)];

/** What a panel shows before its first read is in, or when that read failed. */
const pending = (error: string | undefined): Row[] => [error ? [span(`cannot read: ${error}`, STYLE.bad)] : dimRow('reading…')];

/** One gauge of a panel: what it measures, how full it is, and what that is in units. */
type Meter = {
  label: string;
  percent?: number;
  value: Row;
  /** Said after the value where the bars can spare the room for every meter's. */
  extra?: Row;
};

/** The narrowest a bar is made to keep a value's `extra`. */
const BAR_MIN = 5;

/**
 * Meters as `label ██████░░░ 62%  value`, one a line, their labels, bars and values in columns:
 * the labels in at most a third of the width, the values against the right, the bars as wide as
 * what is left. `extras` says whether the values carry their extras, `labelWidth` how wide the
 * label column came out, for a line set under it.
 */
const meterRows = (meters: Meter[], width: number): { rows: Row[]; extras: boolean; labelWidth: number } => {
  const labelWidth = Math.min(Math.max(0, ...meters.map((meter) => textWidth(meter.label))) + 1, Math.max(6, Math.floor(width / 3)));
  const room = width - labelWidth - 5 - 2;
  const valueOf = (meter: Meter, extra: boolean): Row => [...meter.value, ...(extra && meter.extra ? meter.extra : [])];
  const widest = (extra: boolean) => Math.max(0, ...meters.map((meter) => rowWidth(valueOf(meter, extra))));
  const extras = widest(true) <= room - BAR_MIN;
  const valueWidth = Math.max(0, Math.min(room - 2, widest(extras)));
  const barWidth = Math.max(0, width - labelWidth - 5 - (valueWidth ? valueWidth + 2 : 0));
  const rows = meters.map((meter): Row => {
    const style = bandStyle(meter.percent);
    return [
      span(padEnd(cut(meter.label, labelWidth - 1), labelWidth), STYLE.label),
      ...(meter.percent === undefined ? [span(' '.repeat(barWidth))] : gauge(meter.percent / 100, barWidth, style)),
      span(' ' + padStart(meter.percent === undefined ? '—' : `${Math.round(meter.percent)}%`, 4), meter.percent === undefined ? STYLE.dim : style),
      ...(valueWidth ? [span('  '), ...fit(valueOf(meter, extras), valueWidth)] : []),
    ];
  });
  return { rows, extras, labelWidth };
};

const header = (data: TopData, view: TopView, width: number, now: number): Row => {
  const users = new Set((data.sessions ?? []).filter((session) => session.uid !== GUEST_UID).map((session) => session.user)).size;
  const cores = data.cores ?? data.host?.cpu?.cores;
  const left: Row = [
    span(' EiN top ', STYLE.badge),
    span('  '),
    span(data.info.hostname || 'this host', STYLE.value),
    SEPARATOR,
    span(`up ${formatUptime(data.info.uptimeMs)}`),
    SEPARATOR,
    span(`${users} ${users === 1 ? 'user' : 'users'}`),
  ];
  if (data.load) {
    left.push(SEPARATOR, span('load', STYLE.label));
    for (const load of data.load) {
      const share = cores ? load / cores : 0;
      left.push(span(' ' + load.toFixed(2), share >= 1 ? STYLE.bad : share >= 0.75 ? STYLE.warn : ''));
    }
  }
  const right: Row = [
    ...(view.paused ? [span(' paused ', '1;38;5;234;48;5;172'), span('  ')] : []),
    span(clock(now), STYLE.value),
    span(' '),
  ];
  return spread(left, right, width);
};

const footer = (view: TopView, width: number): Row => {
  const key = (text: string) => span(text, STYLE.key);
  const label = (text: string) => span(text, STYLE.dim);
  return fit([
    span(' '),
    key('q'),
    label(' quit   '),
    key('↑↓'),
    label(' scroll   '),
    key('s'),
    label(` sort: ${view.sort}   `),
    key('+ -'),
    label(` every ${view.tickMs / 1000}s   `),
    key('p'),
    label(view.paused ? ' resume   ' : ' pause   '),
    key('space'),
    label(' refresh'),
  ], width);
};

/**
 * The CPU graph's columns, one a tick, oldest first: this `top`'s readings, and before the first
 * of them the sampler's, each spread over as many ticks as its interval spans — so the graph has
 * the last minutes from the first frame on rather than filling in from empty.
 */
export const cpuColumns = (live: MetricPoint[], history: MetricPoint[], tickMs: number): number[] => {
  const since = live[0]?.at ?? Infinity;
  const earlier = history.filter((point) => point.at < since);
  const columns: number[] = [];
  earlier.forEach((point, i) => {
    const ticks = i === 0 ? 1 : Math.max(1, Math.round((point.at - earlier[i - 1].at) / tickMs));
    for (let tick = 0; tick < ticks; tick++) columns.push(point.value);
  });
  return [...columns, ...live.map((point) => point.value)];
};

const cpuPanel = (data: TopData, view: TopView, body: number): Panel => ({
  min: 5,
  want: Math.max(6, Math.min(14, Math.floor(body * 0.28))),
  draw: (width, height) => {
    // The sampler's last reading stands in until two probes are in.
    const now = data.cpu.at(-1)?.value ?? data.host?.cpu?.percent;
    const cores = data.cores ?? data.host?.cpu?.cores;
    const info: Row = now === undefined ? dimRow('—') : [span(`${Math.round(now)}%`, `1;${bandStyle(now)}`), ...(cores ? [span(` of ${cores} cores`, STYLE.dim)] : [])];
    const graphWidth = boxInner(width);
    const content = data.cores === undefined && data.cpu.length === 0 && data.host?.cpu === undefined
      ? [dimRow('no CPU counter on this host')]
      : areaGraph(cpuColumns(data.cpu, data.host?.cpu?.series ?? [], view.tickMs).map((value) => value / 100), graphWidth, height - 2, heatStyle);
    const footerRow = dimRow(`last ${fmtAge(graphWidth * view.tickMs)}`);
    return box([span('CPU')], info, content, width, height, footerRow);
  },
});

const lagRow = (lag: HostMetrics['lag'], labelWidth: number): Row => {
  if (!lag) return [span(padEnd('lag', labelWidth), STYLE.label), span('no sample yet', STYLE.dim)];
  return [
    span(padEnd('lag', labelWidth), STYLE.label),
    span('p99 ', STYLE.dim),
    span(fmtMs(lag.p99Ms), lagStyle(lag.p99Ms)),
    span('   max ', STYLE.dim),
    span(fmtMs(lag.maxMs), lagStyle(lag.maxMs)),
  ];
};

const memoryPanel = (data: TopData): Panel => ({
  min: 5,
  want: 5 + (data.gauges?.length ?? 0),
  draw: (width, height) => {
    const inner = boxInner(width);
    const memory = data.memory;
    const percent = memory?.limitBytes ? (memory.usedBytes / memory.limitBytes) * 100 : data.host?.memory?.percent;
    const used = memory?.usedBytes ?? data.host?.memory?.usedBytes;
    const limit = memory?.limitBytes ?? data.host?.memory?.limitBytes;
    const heapPercent = data.heap.limitBytes > 0 ? (data.heap.usedBytes / data.heap.limitBytes) * 100 : undefined;
    const content = [
      ...meterRows([
        { label: 'RAM', percent, value: used === undefined ? dimRow('no cgroup memory here') : [span(`${fmtBytes(used)} of ${fmtBytes(limit)}`)] },
        { label: 'heap', percent: heapPercent, value: [span(`${fmtBytes(data.heap.usedBytes)} of ${fmtBytes(data.heap.limitBytes)}`)] },
        // A service's meters beside the host's: ems's card.
        ...(data.gauges ?? []).map((gauge): Meter => ({ label: gauge.label, percent: gauge.percent, value: [span(gauge.value)] })),
      ], inner).rows,
      lagRow(data.host?.lag, 5),
    ];
    return box([span('Memory')], [], content, width, height);
  },
});

/**
 * Storage, a meter per filesystem: tiers on one device share their free space, so they share a
 * line, named for all of them (`disk/volatile`), rather than repeat one number as several.
 */
const diskPanel = (data: TopData): Panel => {
  const devices = new Map<string, StorageTier[]>();
  for (const tier of data.disk?.tiers ?? []) {
    const key = tier.device || tier.path;
    devices.set(key, [...(devices.get(key) ?? []), tier]);
  }
  const filesystems = [...devices.values()].map((tiers) => ({ ...tiers[0], tier: tiers.map((tier) => tier.tier).join('/') }));
  const database = data.disk?.databaseBytes;
  const lines = Math.max(1, filesystems.length + (database !== undefined ? 1 : 0));
  return {
    min: 3,
    want: 2 + lines,
    draw: (width, height) => {
      const inner = boxInner(width);
      const meters = filesystems.map((fs): Meter => {
        const days = fs.daysUntilFull;
        return {
          label: fs.tier,
          percent: fs.usedPercent,
          value: [span(`${fmtBytes(fs.freeBytes)} free`)],
          extra: days === undefined ? undefined : [span(' · full ~', STYLE.dim), span(`${days}d`, days < URGENT_DAYS ? `1;${STYLE.bad}` : STYLE.dim)],
        };
      });
      const meter = meterRows(meters, inner);
      const content: Row[] = !data.disk ? pending(data.errors.disk) : meter.rows;
      if (data.disk && filesystems.length === 0) content.push(dimRow('no disk sample yet'));
      if (database !== undefined) content.push([span(padEnd('database', Math.max(9, meter.labelWidth)), STYLE.label), span(fmtBytes(database))]);
      // A filesystem about to fill is said on the frame when its line has no room to say it.
      const urgent = meter.extras ? [] : filesystems.filter((fs) => fs.daysUntilFull !== undefined && fs.daysUntilFull < URGENT_DAYS);
      const warning = urgent.length ? [span(urgent.map((fs) => `${fs.tier} full ~${fs.daysUntilFull}d`).join(', '), `1;${STYLE.bad}`)] : [];
      return box([span('Disk')], [], content, width, height, warning);
    },
  };
};

/** The pipeline work, as the dashboard's Work tab counts it, with what is executing now. */
const workLines = (data: TopData, width: number, now: number): Row[] => {
  const work = data.work;
  if (!work) return pending(data.errors.work);

  const status = work.instances.byStatus;
  const state = (style: string, value: number, label: string): Row => [span('● ', style), span(count(value), STYLE.value), span(` ${label}   `, STYLE.label)];
  const lines: Row[] = [[
    ...state(STYLE.running, status.running, 'running'),
    ...state(STYLE.warn, status.queued, 'queued'),
    ...state(STYLE.bad, status.failed + status.cancelled, 'failed'),
    ...state(STYLE.ok, status.completed, 'done'),
  ]];

  // `health`'s verdict, then every check that is not fine, before anything else: a kind no worker
  // offers, work waiting for EMS or for hardware, failed work for a person.
  const health = assessHealth({
    pools: data.pools ?? [],
    work,
    attention: data.attention ?? { needsPerson: 0, input: 0 },
    services: data.serviceChecks ?? [],
  }, now);
  lines.push([span(health.summary, `1;${VERDICT_STYLE[health.verdict]}`)]);
  for (const check of health.checks) {
    if (check.state === 'ok') continue;
    const style = check.state === 'fail' ? STYLE.bad : STYLE.warn;
    lines.push([span('▲ ', style), span(check.name, style), span(`  ${check.reason}`)]);
  }

  const pools = (data.pools ?? []).filter((pool) => pool.ready + pool.claimed > 0);
  // The engine's own staging pool is said to be one, the way `pool-stat` says it.
  const poolName = (pool: (typeof pools)[number]) => pool.role === 'intake' && !pool.name.includes('intake') ? `${pool.name} (intake)` : pool.name;
  const nameWidth = Math.min(20, Math.max(0, ...pools.map((pool) => textWidth(poolName(pool)))));
  const waitingWidth = Math.max(0, ...pools.map((pool) => count(pool.ready).length));
  for (const pool of pools) {
    const name = poolName(pool);
    lines.push([
      span(padEnd(cut(name, nameWidth), nameWidth + 2), STYLE.label),
      span(padStart(count(pool.ready), waitingWidth), STYLE.value),
      span(' waiting  ', STYLE.dim),
      span(count(pool.claimed), pool.claimed > 0 ? STYLE.running : ''),
      span(' claimed', STYLE.dim),
      ...(pool.perHour !== undefined ? [span('  ' + count(pool.perHour)), span('/h', STYLE.dim)] : []),
      ...(pool.etaMs !== undefined ? [span('  eta ', STYLE.dim), span(fmtEta(pool.etaMs))] : []),
    ]);
  }

  // Executing now, the longest first: a step that has run for an hour is the one to look at.
  const active = [...work.active].sort((a, b) => a.executingSince - b.executingSince);
  const pipelineWidth = Math.min(18, Math.max(0, ...active.map((instance) => textWidth(instance.pipeline))));
  for (const instance of active) {
    const elapsed = padStart(fmtAge(now - instance.executingSince), 6);
    const pathWidth = Math.max(0, width - 2 - pipelineWidth - 2 - 8);
    lines.push([
      span('▸ ', STYLE.running),
      span(padEnd(cut(instance.pipeline, pipelineWidth), pipelineWidth + 2)),
      span(padEnd(cutStart(instance.triggerPath, pathWidth), pathWidth), STYLE.dim),
      span('  ' + elapsed),
    ]);
  }
  return lines;
};

const workPanel = (data: TopData, width: number, now: number): Panel => {
  const lines = workLines(data, boxInner(width), now);
  const lastHour = sum((data.work?.completions ?? []).filter((bucket) => bucket.at >= now - 3_600_000).map((bucket) => bucket.count));
  return {
    min: 3,
    want: 2 + lines.length,
    draw: (w, height) => box([span('Work')], data.work ? [span(count(lastHour), STYLE.value), span(' done in the last hour', STYLE.dim)] : [], lines, w, height),
  };
};

const sortProcesses = (processes: ProcessEntry[], sort: ProcessSort): ProcessEntry[] => {
  const sorted = [...processes];
  switch (sort) {
    case 'newest':
      return sorted.sort((a, b) => b.startedAt - a.startedAt);
    case 'oldest':
      return sorted.sort((a, b) => a.startedAt - b.startedAt);
    case 'user':
      return sorted.sort((a, b) => a.user.localeCompare(b.user) || b.startedAt - a.startedAt);
    case 'command':
      return sorted.sort((a, b) => a.name.localeCompare(b.name) || b.startedAt - a.startedAt);
  }
};

/** Columns `USER TTY TIME rest` for a table of people's shells. */
const tableColumns = (users: string[], ttys: string[]) => ({
  user: Math.min(12, Math.max(4, ...users.map(textWidth))),
  tty: Math.min(18, Math.max(3, ...ttys.map(textWidth))),
});

const processPanel = (data: TopData, view: TopView, list: ListState, now: number): Panel => {
  const processes = sortProcesses(data.processes ?? [], view.sort);
  return {
    min: 6,
    want: 3 + Math.min(processes.length, 5),
    grow: true,
    draw: (width, height) => {
      if (!data.processes) return box([span('Processes')], [], pending(data.errors.processes), width, height);
      const page = Math.max(0, height - 3);
      list.page = page;
      list.scroll = Math.max(0, Math.min(view.scroll, processes.length - page));
      const ttys = processes.map((entry) => fmtTty(entry.tty, entry.origin, entry.service));
      const columns = tableColumns(processes.map((entry) => entry.user), ttys);
      const headRow: Row = [span(`${padEnd('USER', columns.user)}  ${padEnd('TTY', columns.tty)}  ${padStart('TIME', 6)}  COMMAND`, STYLE.dim)];
      const rows = processes.slice(list.scroll, list.scroll + page).map((entry, i): Row => {
        const index = list.scroll + i;
        return [
          span(padEnd(cut(entry.user, columns.user), columns.user + 2)),
          span(padEnd(cut(ttys[index], columns.tty), columns.tty + 2), ORIGIN_STYLE[entry.origin]),
          span(padStart(fmtAge(now - entry.startedAt), 6) + '  ', STYLE.dim),
          span(entry.name, STYLE.value),
          span(entry.label !== undefined ? `: ${labelLine(entry.label)}` : entry.args.map((arg) => ' ' + quoteWord(arg)).join('')),
          ...(entry.foreground ? [] : [span(' &', STYLE.dim)]),
        ];
      });
      const info: Row = [span(count(processes.length), STYLE.value), span(` running · ${view.sort} first`, STYLE.dim)];
      const shown = processes.length > page ? dimRow(`${list.scroll + 1}–${Math.min(processes.length, list.scroll + page)} of ${processes.length}`) : [];
      return box([span('Processes')], info, [headRow, ...rows], width, height, shown);
    },
  };
};

const sessionPanel = (data: TopData, now: number): Panel => {
  const sessions = data.sessions ?? [];
  return {
    min: 4,
    want: 3 + Math.max(1, sessions.length),
    draw: (width, height) => {
      if (!data.sessions) return box([span('Sessions')], [], pending(data.errors.sessions), width, height);
      const ttys = sessions.map((session) => fmtTty(session.tty, session.origin));
      const columns = tableColumns(sessions.map((session) => session.user), ttys);
      const from = Math.min(15, Math.max(4, ...sessions.map((session) => textWidth(session.from ?? '-'))));
      const headRow: Row = [span(`${padEnd('USER', columns.user)}  ${padEnd('TTY', columns.tty)}  ${padEnd('FROM', from)}  ${padStart('IDLE', 6)}  WHAT`, STYLE.dim)];
      const rows = sessions.map((session, i): Row => [
        span(padEnd(cut(session.user, columns.user), columns.user + 2), session.uid === GUEST_UID ? STYLE.dim : STYLE.value),
        span(padEnd(cut(ttys[i], columns.tty), columns.tty + 2), ORIGIN_STYLE[session.origin]),
        span(padEnd(cut(session.from ?? '-', from), from + 2), session.from ? STYLE.value : STYLE.dim),
        span(padStart(fmtAge(now - session.activeAt), 6) + '  ', STYLE.dim),
        session.command ? span(session.command) : span('-', STYLE.dim),
      ]);
      const content = sessions.length > 0 ? [headRow, ...rows] : [dimRow('nobody signed in')];
      const hidden = sessions.length - Math.max(0, height - 3);
      return box(
        [span('Sessions')],
        [span(count(sessions.length), STYLE.value), span(' open', STYLE.dim)],
        content,
        width,
        height,
        hidden > 0 ? dimRow(`${hidden} more`) : [],
      );
    },
  };
};

const SERVICE_MARK: Record<string, [string, string]> = {
  running: ['●', STYLE.ok],
  failed: ['✗', STYLE.bad],
  stopped: ['○', STYLE.dim],
};

const serviceMark = (service: ServiceEntry): Row => {
  const [mark, style] = SERVICE_MARK[service.status] ?? ['◐', STYLE.warn];
  return [span(mark + ' ', style)];
};

const servicePanel = (data: TopData, now: number): Panel => {
  const services = data.services ?? [];
  return {
    min: 3,
    want: 2 + Math.max(1, services.length),
    draw: (width, height) => {
      if (!data.services) return box([span('Services')], [], pending(data.errors.services), width, height);
      const inner = boxInner(width);
      const failed = services.filter((service) => service.status === 'failed').length;
      const running = services.filter((service) => service.status === 'running').length;
      const info: Row = [span(count(running), STYLE.value), span(' running', STYLE.dim), ...(failed ? [span(`  ${failed} failed`, STYLE.bad)] : [])];
      const restarts = (service: ServiceEntry): Row => service.restartCount > 0 ? [span(` ↻${service.restartCount}`, STYLE.warn)] : [];
      let content: Row[];
      let footerRow: Row = [];
      if (services.length === 0) {
        content = [dimRow('no services')];
      } else if (services.length <= height - 2) {
        // A line each: how long it has run, and what it says about itself.
        const nameWidth = Math.min(24, Math.max(...services.map((service) => textWidth(service.name))));
        content = services.map((service) => [
          ...serviceMark(service),
          span(padEnd(cut(service.name, nameWidth), nameWidth + 2), service.status === 'running' ? '' : STYLE.dim),
          span(padStart(service.startedAt ? fmtAge(now - service.startedAt) : '', 6), STYLE.dim),
          ...restarts(service),
          ...(service.detail ? [span('  ' + service.detail, STYLE.dim)] : []),
        ]);
      } else {
        // Too many for a line each: marks and names, as many to a line as fit, the failed first.
        const order = (service: ServiceEntry) => ['failed', 'running', 'stopped'].indexOf(service.status) + 1;
        const lines = Math.max(1, height - 2);
        content = [[]];
        let shown = 0;
        for (const service of [...services].sort((a, b) => order(a) - order(b))) {
          const chip: Row = [...serviceMark(service), span(service.name, service.status === 'running' ? '' : STYLE.dim), ...restarts(service), span('   ')];
          if (rowWidth(content[content.length - 1]) + rowWidth(chip) - 3 > inner) {
            if (content.length === lines) break;
            content.push([]);
          }
          content[content.length - 1].push(...chip);
          shown++;
        }
        if (shown < services.length) footerRow = dimRow(`${services.length - shown} more`);
      }
      return box([span('Services')], info, content, width, height, footerRow);
    },
  };
};

const LEVEL_STYLE: Record<string, string> = { WARN: STYLE.warn, ERROR: STYLE.bad };

const problemPanel = (data: TopData): Panel => {
  const problems = data.problems ?? [];
  return {
    min: 4,
    want: 2 + Math.max(1, Math.min(problems.length, 6)),
    draw: (width, height) => {
      if (!data.problems) return box([span('Problems')], [], pending(data.errors.problems), width, height);
      // The newest at the bottom, as a log reads; the oldest give way.
      const shown = problems.slice(-Math.max(0, height - 2));
      const content: Row[] = shown.length === 0 ? [[span('no warnings or errors in the system log', STYLE.ok)]] : shown.map((line) => {
        const at = Date.parse(line.timestamp);
        return [
          span((Number.isFinite(at) ? clock(at) : line.timestamp.slice(0, 8)) + ' ', STYLE.dim),
          span(padEnd(line.level, 6), LEVEL_STYLE[line.level] ?? ''),
          span(line.name + '  ', STYLE.label),
          span(line.message),
        ];
      });
      const hidden = problems.length - shown.length;
      return box([span('Problems')], [span('dmesg --level warn', STYLE.dim)], content, width, height, hidden > 0 ? dimRow(`${hidden} older`) : []);
    },
  };
};

/** The bands for a terminal `cols` wide, in the order they are drawn. */
const arrange = (data: TopData, view: TopView, cols: number, body: number, list: ListState, now: number): Band[] => {
  if (cols >= WIDE) {
    const right = Math.max(50, Math.round(cols * 0.4));
    const left = cols - right;
    return [
      { rank: 0, columns: [{ width: left, panels: [cpuPanel(data, view, body)] }, { width: right, panels: [memoryPanel(data), diskPanel(data)] }] },
      { rank: 1, columns: [{ width: left, panels: [workPanel(data, left, now)] }, { width: right, panels: [sessionPanel(data, now)] }] },
      { rank: 2, columns: [{ width: left, panels: [processPanel(data, view, list, now)] }, { width: right, panels: [servicePanel(data, now)] }] },
      // Log lines are long: the full width, last.
      { rank: 3, columns: [{ width: cols, panels: [problemPanel(data)] }] },
    ];
  }
  const pair = (rank: number, a: Panel, b: Panel): Band[] => {
    if (cols < PAIRED) return [{ rank, columns: [{ width: cols, panels: [a] }] }, { rank: rank + 0.5, columns: [{ width: cols, panels: [b] }] }];
    const left = Math.round(cols / 2);
    return [{ rank, columns: [{ width: left, panels: [a] }, { width: cols - left, panels: [b] }] }];
  };
  return [
    { rank: 0, columns: [{ width: cols, panels: [cpuPanel(data, view, body)] }] },
    ...pair(1, memoryPanel(data), diskPanel(data)),
    { rank: 2, columns: [{ width: cols, panels: [workPanel(data, cols, now)] }] },
    { rank: 3, columns: [{ width: cols, panels: [processPanel(data, view, list, now)] }] },
    ...pair(4, sessionPanel(data, now), servicePanel(data, now)),
    { rank: 6, columns: [{ width: cols, panels: [problemPanel(data)] }] },
  ];
};

const bandMin = (band: Band): number => Math.max(...band.columns.map((column) => sum(column.panels.map((panel) => panel.min))));
const bandWant = (band: Band): number => Math.max(...band.columns.map((column) => sum(column.panels.map((panel) => panel.want))));

/** Each band's rows, 0 for a band left out. */
const allot = (bands: Band[], height: number): number[] => {
  const kept = new Set(bands);
  let need = sum(bands.map(bandMin));
  for (const band of [...bands].sort((a, b) => b.rank - a.rank)) {
    if (need <= height || kept.size === 1) break;
    kept.delete(band);
    need -= bandMin(band);
  }

  const rows = new Map([...kept].map((band) => [band, bandMin(band)]));
  let left = height - need;
  for (const band of [...kept].sort((a, b) => a.rank - b.rank)) {
    const more = Math.max(0, Math.min(left, bandWant(band) - rows.get(band)!));
    rows.set(band, rows.get(band)! + more);
    left -= more;
  }
  const growing = [...kept].find((band) => band.columns.some((column) => column.panels.some((panel) => panel.grow))) ?? [...kept].at(-1);
  if (growing && left > 0) rows.set(growing, rows.get(growing)! + left);
  return bands.map((band) => rows.get(band) ?? 0);
};

/** A column of panels in `height` rows: each its fewest, then its most in order, the rest to the one that grows. */
const stack = (panels: Panel[], width: number, height: number): Row[] => {
  const shown = [...panels];
  while (shown.length > 1 && sum(shown.map((panel) => panel.min)) > height) shown.pop();
  const rows = shown.map((panel) => panel.min);
  let left = height - sum(rows);
  shown.forEach((panel, i) => {
    const more = Math.max(0, Math.min(left, panel.want - rows[i]));
    rows[i] += more;
    left -= more;
  });
  const growing = shown.findIndex((panel) => panel.grow);
  rows[growing >= 0 ? growing : rows.length - 1] += Math.max(0, left);
  const out = shown.flatMap((panel, i) => panel.draw(width, rows[i]));
  while (out.length < height) out.push(fit([], width));
  return out.slice(0, height);
};

/**
 * The frame for a terminal `rows` by `cols`. With `keys`, its last row is the line of keys, one
 * column short of the edge: writing the bottom right cell leaves some terminals about to scroll.
 */
export const renderTop = (data: TopData, view: TopView, size: { rows: number; cols: number }, opts: { keys: boolean; now?: number }): TopFrame => {
  const now = opts.now ?? Date.now();
  const cols = Math.max(1, size.cols);
  const body = Math.max(0, size.rows - 1 - (opts.keys ? 1 : 0));
  const list: ListState = { page: 0, scroll: view.scroll };

  const out: Row[] = [header(data, view, cols, now)];
  const bands = arrange(data, view, cols, body, list, now);
  allot(bands, body).forEach((height, i) => {
    if (height <= 0) return;
    const columns = bands[i].columns.map((column) => stack(column.panels, column.width, height));
    for (let row = 0; row < height; row++) out.push(columns.flatMap((column) => column[row]));
  });
  while (out.length < 1 + body) out.push(fit([], cols));
  out.length = Math.min(out.length, 1 + body);
  if (opts.keys && size.rows >= 2) out.push(footer(view, cols - 1));
  return { rows: out.slice(0, Math.max(1, size.rows)), page: list.page, scroll: list.scroll };
};
