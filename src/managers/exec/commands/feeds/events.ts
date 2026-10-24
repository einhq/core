/**
 * events — what falls on the days around a date, from every `events-*` command on PATH, in date
 * order.
 *
 * The limit keeps milestones first, then the nearest, across all providers. Cutting on nearness
 * alone would drop a golden wedding three weeks out for a dozen ordinary birthdays tomorrow.
 */
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { EventEntry } from '../../../../lib/api/feeds.ts';
import { count, entryBase, gather, gatheredFailure } from '../../../../lib/feeds/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * The window and the limit, which the home page's Events takes as they are. A family archive of a
 * few hundred people yields roughly one anniversary a day, so "the next month, and the week just
 * gone" is a card somebody reads; widening it turns the home page into a list of birthdays with
 * everything else below the fold.
 */
const DEFAULT_DAYS_AHEAD = 30;
const DEFAULT_DAYS_PAST = 7;
const DEFAULT_LIMIT = 16;

const MS_PER_DAY = 86_400_000;

const dayMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** A real calendar day as `YYYY-MM-DD`. */
const isDay = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(dayMs(date)) && new Date(dayMs(date)).toISOString().slice(0, 10) === date;

const readEvent = (raw: Record<string, unknown>, source: string): EventEntry | undefined =>
  typeof raw.date === 'string' && isDay(raw.date) ? { ...entryBase(raw, source), date: raw.date, ...(raw.milestone === true ? { milestone: true } : {}) } : undefined;

export const events = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['today', 'days-ahead', 'days-past', 'limit'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const numbers: Record<string, number> = {};
  for (const [name, fallback] of [['days-ahead', DEFAULT_DAYS_AHEAD], ['days-past', DEFAULT_DAYS_PAST], ['limit', DEFAULT_LIMIT]] as const) {
    const value = count(flags[name], fallback);
    if (value === undefined) {
      await cmd.writeError(`events: --${name} must be a non-negative whole number\n`);
      return 1;
    }
    numbers[name] = value;
  }
  const today = flags.today ?? new Date().toISOString().slice(0, 10);
  if (!isDay(today)) {
    await cmd.writeError(`events: --today must be YYYY-MM-DD, got '${today}'\n`);
    return 1;
  }

  const ahead = numbers['days-ahead'];
  const past = numbers['days-past'];
  const limit = numbers.limit;
  const gathered = limit > 0
    ? await gather(cmd, 'events', `--today ${today} --days-ahead ${ahead} --days-past ${past} --limit ${limit}`, readEvent)
    : { entries: [], providers: 0, answered: 0 };
  const failed = gatheredFailure(cmd, gathered);
  if (failed !== undefined) return failed;

  const daysAway = (entry: EventEntry): number => Math.round((dayMs(entry.date) - dayMs(today)) / MS_PER_DAY);
  const entries = gathered.entries
    .filter((entry) => daysAway(entry) <= ahead && -daysAway(entry) <= past)
    // Of two as near, the one still to come survives.
    .sort((a, b) => Number(b.milestone ?? false) - Number(a.milestone ?? false) || Math.abs(daysAway(a)) - Math.abs(daysAway(b)) || daysAway(b) - daysAway(a))
    .slice(0, limit)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies EventEntry[]);
    return 0;
  }
  for (const entry of entries) {
    const days = daysAway(entry);
    const when = days === 0 ? 'today' : days > 0 ? `in ${days}d` : `${-days}d ago`;
    await cmd.writeLn(`${entry.date}  ${when.padStart(8)}  ${entry.milestone ? '*' : ' '} ${entry.title}`);
  }
  return 0;
};

events.spec = {
  name: 'events',
  effect: 'read' as const,
  description: 'What falls on the days around a date, from every events-* command on PATH',
  args: [],
  flags: [
    { name: 'today', type: 'string' as const, description: 'the date to look around, YYYY-MM-DD (default today, UTC)' },
    { name: 'days-ahead', type: 'number' as const, description: `how far forward to look (default ${DEFAULT_DAYS_AHEAD})` },
    { name: 'days-past', type: 'number' as const, description: `how far back to look (default ${DEFAULT_DAYS_PAST})` },
    { name: 'limit', type: 'number' as const, description: `entries returned across all providers; milestones, then the nearest, survive the cut (default ${DEFAULT_LIMIT})` },
  ],
  examples: [
    'events',
    'events --days-ahead 0 --days-past 0',
    'events --today 2026-12-24 --days-ahead 7',
  ],
  returns:
    'the entries of every events-* provider in the window, in date order: the day, what, whether it is a milestone, the node it is about, which provider, and the route that draws it.',
};
