/**
 * The fan-out behind `news`, `events` and `onthisday`: every `<feed>-*` command on `PATH` asked the
 * same question at once, and their entries gathered into one list, each marked with the provider
 * it came from. Ordering and the limit are the calling command's.
 */
import type { Command } from '../../managers/exec/command.ts';
import { signalExitCode } from '../../managers/exec/signal.ts';
import { commandsNamed } from '../../managers/shell/command-lookup.ts';

type Gathered<T> = {
  entries: T[];
  /** How many providers are on `PATH`. */
  providers: number;
  /** How many of them answered with a list. */
  answered: number;
};

/** What every entry carries, read from a provider's: the `title`, `route` and `path` it gave, and `source`. */
export const entryBase = (raw: Record<string, unknown>, source: string): { title: string; route: string; source: string; path?: string } => ({
  title: raw.title as string,
  route: raw.route as string,
  source,
  ...(typeof raw.path === 'string' && raw.path.startsWith('/') ? { path: raw.path } : {}),
});

/**
 * The exit code for a gathering: `undefined` to answer, otherwise what to return. A gathering
 * interrupted by a signal hung its providers up, which says nothing about them; one in which every
 * provider failed has nothing to answer with.
 */
export const gatheredFailure = (cmd: Command, gathered: Gathered<unknown>): number | undefined => {
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return gathered.providers > 0 && gathered.answered === 0 ? 1 : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Ask each `<feed>-*` provider `question` under `JSON_OUTPUT=1` and keep what `read` makes of each
 * entry that has a `title` and a `route`. A provider that fails, or answers anything but a list,
 * is named on stderr and adds nothing; so is an entry `read` refuses. The others still count: one
 * module's trouble does not empty the feed.
 */
export const gather = async <T>(
  cmd: Command,
  feed: string,
  question: string,
  read: (raw: Record<string, unknown>, source: string) => T | undefined,
): Promise<Gathered<T>> => {
  const prefix = `${feed}-`;
  const providers = await commandsNamed(cmd.sys.vfs, cmd.env.PATH ?? '', prefix);
  // Read-only and independent of each other, so they run together rather than back to back.
  const runs = await Promise.all(providers.map(async (provider) => ({ provider, run: await cmd.execute(`JSON_OUTPUT=1 ${provider} ${question}`) })));
  if (cmd.interrupted) return { entries: [], providers: providers.length, answered: 0 };

  const entries: T[] = [];
  let answered = 0;
  for (const { provider, run } of runs) {
    const said = run.stderr.trim();
    if (run.code !== 0) {
      await cmd.writeError(`${feed}: ${provider}: ${said || `exit ${run.code}`}\n`);
      continue;
    }
    let answer: unknown;
    try {
      answer = JSON.parse(run.stdout);
    } catch {
      answer = undefined;
    }
    if (!Array.isArray(answer)) {
      await cmd.writeError(`${feed}: ${provider}: answered something other than a list of entries${said ? `: ${said}` : ''}\n`);
      continue;
    }
    answered++;
    if (said) await cmd.writeError(`${feed}: ${provider}: ${said}\n`);

    const source = provider.slice(prefix.length);
    let dropped = 0;
    for (const raw of answer) {
      const entry = isRecord(raw) && typeof raw.title === 'string' && typeof raw.route === 'string' && raw.route.startsWith('/') ? read(raw, source) : undefined;
      if (entry === undefined) dropped++;
      else entries.push(entry);
    }
    if (dropped > 0) await cmd.writeError(`${feed}: ${provider}: left out ${dropped} ${dropped === 1 ? 'entry' : 'entries'} not in the ${feed} shape\n`);
  }
  return { entries, providers: providers.length, answered };
};

/**
 * A count flag's value: `fallback` when absent, `undefined` when not a whole number from 0 up. A
 * negative one arrives as an empty value (a leading `-` starts a new flag), and an unguarded
 * `Number('')` would be a silent 0.
 */
export const count = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : undefined;
};
