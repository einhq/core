import { SYSTEM_LOG_PATH } from '../../../../lib/paths.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { resolve } from '@std/path';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import type { LogLine } from '../../../../lib/api/system.ts';
import { type ResourceHandleIf, ResourceSeekMode } from '../../../../registries/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const LEVEL_COLORS: Record<string, Parameters<ReturnType<typeof colorer>>[0]> = {
  DEBUG: 'dim',
  INFO: 'cyan',
  WARN: 'yellow',
  ERROR: 'red',
};

const KNOWN_FIELDS = new Set(['level', 'name', 'message', 'timestamp']);

/** Severity order for `--level`; a line whose level is not one of these passes no filter. */
export const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/** Lines read from the end first when only the last few are wanted; each retry reads four times as many. */
const TAIL_WINDOW = 1000;

/** One line of a log, as JSON with level, name, message and timestamp, or as the text it is. */
const parseLine = (raw: string): LogLine => {
  try {
    const entry = JSON.parse(raw) as Record<string, unknown>;
    const extraFields = Object.entries(entry)
      .filter(([k]) => !KNOWN_FIELDS.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);

    return {
      level: String(entry.level ?? 'INFO'),
      name: String(entry.name ?? '?'),
      message: String(entry.message ?? raw),
      timestamp: String(entry.timestamp ?? ''),
      extra: extraFields.join(' '),
    };
  } catch {
    return { level: '', name: '', message: raw, timestamp: '', extra: '' };
  }
};

/** Every line from the handle's position to the end; a line a chunk cuts is finished by the next. */
const readLines = async (handle: ResourceHandleIf): Promise<LogLine[]> => {
  const decoder = new TextDecoder();
  const lines: LogLine[] = [];
  let rest = '';
  while (true) {
    const chunk = await handle.read(100);
    if (chunk.length === 0) break;
    const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = parts.pop() ?? '';
    for (const raw of parts) if (raw) lines.push(parseLine(raw));
  }
  rest += decoder.decode();
  if (rest) lines.push(parseLine(rest));
  return lines;
};

/**
 * The lines of a log at `minLevel` (an index into LEVELS) or above, the last `limit` of them when
 * given.
 *
 * With a limit, a log node is read from its end, in windows that grow until one holds enough
 * matching lines or the whole log: the system log holds days of lines, and a dashboard asking
 * every ten seconds for the last ten problems must not read all of them each time.
 */
export const readLogLines = async (cmd: Command, path: string, opts: { minLevel?: number; limit?: number } = {}): Promise<LogLine[]> => {
  const minLevel = opts.minLevel ?? 0;
  const keep = (lines: LogLine[]): LogLine[] => {
    const matching = minLevel > 0 ? lines.filter((line) => LEVELS.indexOf(line.level) >= minLevel) : lines;
    if (opts.limit === undefined) return matching;
    return opts.limit > 0 ? matching.slice(-opts.limit) : [];
  };

  for (let window = TAIL_WINDOW; opts.limit !== undefined; window *= 4) {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      // Only a log seeks by line; anything else is read whole below.
      if (typeof (handle as { readEntries?: unknown }).readEntries !== 'function') break;
      let whole = false;
      try {
        await handle.seek(-window, ResourceSeekMode.End);
      } catch {
        // Fewer lines than the window: the read starts at the first.
        whole = true;
      }
      const lines = keep(await readLines(handle));
      if (whole || lines.length >= opts.limit) return lines;
    } finally {
      await handle.close();
    }
  }

  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    return keep(await readLines(handle));
  } finally {
    await handle.close();
  }
};

export const dmesg = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['n', 'level'],
    alias: { n: 'lines' },
  });

  // Applied before `-n`, so `--level warn -n 10` is the last ten problems, not the problems
  // among the last ten lines.
  const minLevel = flags.level === undefined ? 0 : LEVELS.indexOf(flags.level.toUpperCase());
  if (minLevel < 0) {
    await cmd.writeError(`dmesg: --level must be one of ${LEVELS.map((level) => level.toLowerCase()).join(', ')}, got '${flags.level}'\n`);
    return 1;
  }

  const logPath = resolve(cmd.cwd, (flags._[0] as string | undefined) ?? SYSTEM_LOG_PATH);
  const color = colorer(!cmd.tty);
  const lines = flags.n !== undefined ? parseInt(flags.n, 10) : NaN;
  const maxLines = Number.isFinite(lines) ? lines : undefined;

  try {
    const visible = await readLogLines(cmd, logPath, { minLevel, limit: maxLines });

    if (cmd.json) {
      await cmd.writeJSON(visible satisfies LogLine[]);
      return 0;
    }

    if (visible.length === 0) {
      return 0;
    }

    const hasExtra = visible.some((e) => e.extra !== '');

    const tableCols: { name: string; align: 'left' | 'right' }[] = [
      { name: 'timestamp', align: 'left' },
      { name: 'level', align: 'left' },
      { name: 'name', align: 'left' },
      { name: 'message', align: 'left' },
      ...(hasExtra ? [{ name: 'extra', align: 'left' as const }] : []),
    ];

    const table = new Table({ columns: tableCols });

    for (const e of visible) {
      const levelColor = LEVEL_COLORS[e.level] ?? 'white';
      table.addRow({
        timestamp: color('dim', e.timestamp),
        level: color(levelColor, e.level.padEnd(5)),
        name: color('cyan', e.name),
        message: e.message,
        ...(hasExtra ? { extra: e.extra ? color('dim', e.extra) : '' } : {}),
      });
    }

    await cmd.write(table.render());

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await cmd.writeError(`dmesg: ${message}\n`);
    return 1;
  }
};

dmesg.spec = {
  name: 'dmesg',
  effect: 'read' as const,
  description: 'Print system log',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'log node path (default: /var/logs/system)',
      optional: true,
    },
  ],
  flags: [
    {
      name: 'n',
      type: 'string' as const,
      description: 'show last N lines',
    },
    {
      name: 'level',
      type: 'string' as const,
      description: 'only lines at this level or above: debug, info, warn, error',
    },
  ],
};
