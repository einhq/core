/**
 * top — the system at a glance, redrawn as it changes: CPU as a graph, memory and the event loop,
 * the disks, the pipeline work and what is executing, the commands running, who is signed in,
 * the services and the latest problems in the log.
 *
 * This file owns the terminal — raw input, the alternate screen, its size — and the clock; what is
 * read is `sources.ts`, and how it is drawn `render.ts`. Without a terminal, or with `-n`, frames
 * are written one after another instead.
 */

import { parseArgs } from '../../../../../lib/args/mod.ts';
import { type Key, KeyReader } from '../../../../shell/terminal/keys.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import { toAnsi, toText } from './draw.ts';
import { PROCESS_SORTS, renderTop, type TopView } from './render.ts';
import { TopSources } from './sources.ts';

/** The update intervals `+` and `-` step through, in seconds; `-d` may name any other. */
const DELAYS_S = [0.5, 1, 2, 3, 5, 10, 30, 60];

/** The first CPU reading needs a second probe; it is taken this soon rather than a whole tick later. */
const FIRST_PROBE_MS = 500;

/** How long a redraw waits for other reads that land at the same moment. */
const DRAW_COALESCE_MS = 20;

type Action = 'quit' | 'refresh' | 'wake' | undefined;

/** A sleep that `wake` cuts short. */
const alarm = () => {
  let wake = () => {};
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  return { sleep, wake: () => wake() };
};

/** The next update interval up or down the steps, from wherever the current one is. */
const stepDelay = (ms: number, up: boolean): number => {
  const seconds = ms / 1000;
  const next = up ? DELAYS_S.find((step) => step > seconds) : [...DELAYS_S].reverse().find((step) => step < seconds);
  return (next ?? seconds) * 1000;
};

/** What a key does to the view; `page` is how many process rows the list shows. */
const press = (key: Key, view: TopView, page: number): Action => {
  const chars = key.type === 'text' ? [...key.text] : [];
  if (key.type === 'key') {
    if (key.ctrl && key.name === 'c') return 'quit';
    const scroll: Record<string, number> = { up: -1, down: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity };
    if (key.name in scroll) view.scroll = Math.max(0, view.scroll + scroll[key.name]);
    return undefined;
  }
  let action: Action;
  for (const char of chars) {
    if (char === 'q' || char === 'Q') return 'quit';
    if (char === 'k') view.scroll = Math.max(0, view.scroll - 1);
    if (char === 'j') view.scroll += 1;
    if (char === 's') {
      view.sort = PROCESS_SORTS[(PROCESS_SORTS.indexOf(view.sort) + 1) % PROCESS_SORTS.length];
      view.scroll = 0;
    }
    if (char === '+' || char === '-') {
      view.tickMs = stepDelay(view.tickMs, char === '+');
      action ??= 'wake';
    }
    if (char === 'p') {
      view.paused = !view.paused;
      action ??= 'wake';
    }
    if (char === ' ') action = 'refresh';
  }
  return action;
};

/** Frames written one after another, `view.tickMs` apart, as text where there is no terminal to color. */
const writeFrames = async (cmd: Command, view: TopView, frames: number): Promise<number> => {
  const sources = new TopSources(cmd);
  const { sleep, wake } = alarm();
  cmd.onInterrupt(wake);
  try {
    for (let frame = 0; frame < frames && !cmd.interrupted; frame++) {
      if (frame === 0) {
        await sources.tick();
        await sleep(FIRST_PROBE_MS);
      } else {
        await sleep(view.tickMs);
      }
      if (cmd.interrupted) break;
      await sources.tick();
      await sources.settled();
      const { rows } = renderTop(sources.data, view, { rows: cmd.rows, cols: cmd.cols }, { keys: false });
      const text = rows.map((row) => cmd.tty ? toAnsi(row) : toText(row).trimEnd()).join('\n');
      await cmd.write(`${frame > 0 ? '\n' : ''}${text}\n`);
    }
  } finally {
    cmd.onInterrupt(null);
  }
  return cmd.interrupted ? 130 : 0;
};

export const top = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['d', 'n'], alias: { d: 'delay', n: 'frames' } });
  const delay = flags.d === undefined ? 2 : Number(flags.d);
  if (!(delay >= DELAYS_S[0])) {
    await cmd.writeError(`top: -d must be a number of seconds, at least ${DELAYS_S[0]}\n`);
    return 1;
  }
  const frames = flags.n === undefined ? undefined : Number(flags.n);
  if (frames !== undefined && !(Number.isInteger(frames) && frames > 0)) {
    await cmd.writeError('top: -n must be a whole number of frames\n');
    return 1;
  }

  const view: TopView = { sort: 'newest', scroll: 0, tickMs: delay * 1000, paused: false };
  if (!cmd.tty || frames !== undefined) return await writeFrames(cmd, view, frames ?? 1);

  let size = { rows: cmd.rows, cols: cmd.cols };
  let page = 0;
  let previous: string[] = [];
  let writing = Promise.resolve();
  let closed = false;
  let drawTimer: ReturnType<typeof setTimeout> | undefined;

  /** The frame now, only its rows that changed since the last one written. */
  const draw = () => {
    if (closed) return;
    clearTimeout(drawTimer);
    drawTimer = undefined;
    const frame = renderTop(sources.data, view, size, { keys: true });
    page = frame.page;
    view.scroll = frame.scroll;
    const rows = frame.rows.map(toAnsi);
    let out = previous.length === 0 ? '\x1b[0m\x1b[2J' : '';
    rows.forEach((row, i) => {
      if (row !== previous[i]) out += `\x1b[${i + 1};1H${row}`;
    });
    previous = rows;
    if (out) writing = writing.then(() => cmd.write(out)).catch(() => {});
  };

  const sources = new TopSources(cmd, () => {
    if (!view.paused) drawTimer ??= setTimeout(draw, DRAW_COALESCE_MS);
  });
  const { sleep, wake } = alarm();
  let quit = false;

  cmd.setRawMode(true);
  cmd.onInterrupt(() => {
    quit = true;
    wake();
  });
  cmd.onResize((rows, cols) => {
    size = { rows, cols };
    previous = [];
    draw();
  });
  // The alternate screen gives the shell its screen back on exit.
  await cmd.write('\x1b[?1049h\x1b[?25l');

  // Keys until a quit, the end of stdin or a terminating signal, which ends the read in progress.
  void (async () => {
    const keys = new KeyReader();
    try {
      for await (const chunk of cmd.stdin.chunks()) {
        for (const key of keys.feed(chunk)) {
          const action = press(key, view, page);
          if (action === 'quit') quit = true;
          if (action === 'refresh') sources.expire();
          if (action) wake();
        }
        draw();
        if (quit) break;
      }
    } catch {
      // A read that fails ends the keys as the end of stdin does.
    }
    quit = true;
    wake();
  })();

  try {
    for (let first = true; !quit && !cmd.interrupted; first = false) {
      if (!view.paused) await sources.tick();
      draw();
      await sleep(first ? Math.min(FIRST_PROBE_MS, view.tickMs) : view.tickMs);
    }
  } finally {
    closed = true;
    clearTimeout(drawTimer);
    cmd.onResize(null);
    cmd.onInterrupt(null);
    cmd.setRawMode(false);
    await writing;
    await cmd.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
  return cmd.interrupted ? 130 : 0;
};

top.spec = {
  name: 'top',
  effect: 'read' as const,
  json: false,
  description:
    'Watch the system live: CPU graph, memory and event-loop lag, disks, pipeline work, running commands, sessions, services and recent problems. Keys: q quits, arrows scroll, s sorts, + and - change the interval, p pauses',
  args: [],
  flags: [
    { name: 'd', type: 'number' as const, description: 'Seconds between updates (default 2)' },
    { name: 'n', type: 'number' as const, description: 'Write this many frames one after another and stop, as without a terminal' },
  ],
  examples: ['top', 'top -d 5'],
};
