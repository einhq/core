/**
 * onthisday — what the archive has from one calendar day in earlier years, from every
 * `onthisday-*` command on PATH, newest year first and cut to `--limit` as one list.
 */
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { OnThisDayEntry } from '../../../../lib/api/feeds.ts';
import { count, entryBase, gather, gatheredFailure } from '../../../../lib/feeds/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DEFAULT_LIMIT = 8;

const readOnThisDay = (raw: Record<string, unknown>, source: string): OnThisDayEntry | undefined =>
  typeof raw.year === 'number' && Number.isInteger(raw.year) ? { ...entryBase(raw, source), year: raw.year } : undefined;

export const onthisday = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['limit'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const monthDay = (flags._[0] as string | undefined) ?? new Date().toISOString().slice(5, 10);
  // 2000 was a leap year, so 02-29 is a day to ask about and 02-30 is not.
  if (!/^\d{2}-\d{2}$/.test(monthDay) || new Date(`2000-${monthDay}T00:00:00Z`).toISOString().slice(5, 10) !== monthDay) {
    await cmd.writeError(`onthisday: expected the day as MM-DD, got '${monthDay}'\n`);
    return 1;
  }
  const limit = count(flags.limit, DEFAULT_LIMIT);
  if (limit === undefined) {
    await cmd.writeError('onthisday: --limit must be a non-negative whole number\n');
    return 1;
  }

  const gathered = limit > 0 ? await gather(cmd, 'onthisday', `${monthDay} --limit ${limit}`, readOnThisDay) : { entries: [], providers: 0, answered: 0 };
  const failed = gatheredFailure(cmd, gathered);
  if (failed !== undefined) return failed;
  // Stable, so a year's entries keep their provider's order.
  const entries = gathered.entries.sort((a, b) => b.year - a.year).slice(0, limit);

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies OnThisDayEntry[]);
    return 0;
  }
  for (const entry of entries) await cmd.writeLn(`${entry.year}  ${entry.title}`);
  return 0;
};

onthisday.spec = {
  name: 'onthisday',
  effect: 'read' as const,
  description: 'What the archive has from a calendar day (MM-DD, default today) in earlier years, from every onthisday-* command on PATH',
  args: [
    { name: 'day', type: 'string' as const, description: 'day as MM-DD (default today, UTC)' },
  ],
  flags: [
    { name: 'limit', type: 'number' as const, description: `entries returned across all providers (default ${DEFAULT_LIMIT})` },
  ],
  examples: [
    'onthisday',
    'onthisday 06-21 --limit 20',
  ],
  returns: 'the entries of every onthisday-* provider, newest year first: the year, what, the node it is about, which provider, and the route that draws it.',
};
