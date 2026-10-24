/**
 * news — what has been added lately, from every `news-*` command on PATH, newest first and cut to
 * `--limit` as one list.
 */
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { FeedActor, NewsEntry } from '../../../../lib/api/feeds.ts';
import { count, entryBase, gather, gatheredFailure } from '../../../../lib/feeds/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DEFAULT_LIMIT = 8;

const actorOf = (raw: unknown): FeedActor | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { uid, username, name } = raw as Record<string, unknown>;
  if (typeof uid !== 'number' || typeof username !== 'string') return undefined;
  return { uid, username, ...(typeof name === 'string' ? { name } : {}) };
};

const readNews = (raw: Record<string, unknown>, source: string): NewsEntry | undefined => {
  // A time a date can be made of: one in seconds or nanoseconds is no instant to sort or print.
  if (typeof raw.at !== 'number' || Number.isNaN(new Date(raw.at).getTime())) return undefined;
  const by = actorOf(raw.by);
  return {
    ...entryBase(raw, source),
    at: raw.at,
    ...(by ? { by } : {}),
    ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {}),
  };
};

export const news = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['limit'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const limit = count(flags.limit, DEFAULT_LIMIT);
  if (limit === undefined) {
    await cmd.writeError('news: --limit must be a non-negative whole number\n');
    return 1;
  }

  const gathered = limit > 0 ? await gather(cmd, 'news', `--limit ${limit}`, readNews) : { entries: [], providers: 0, answered: 0 };
  const failed = gatheredFailure(cmd, gathered);
  if (failed !== undefined) return failed;
  const entries = gathered.entries.sort((a, b) => b.at - a.at).slice(0, limit);

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies NewsEntry[]);
    return 0;
  }
  for (const entry of entries) await cmd.writeLn(`${new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')}  ${entry.title}`);
  return 0;
};

news.spec = {
  name: 'news',
  effect: 'read' as const,
  description: 'What has been added lately, newest first, from every news-* command on PATH',
  args: [],
  flags: [
    { name: 'limit', type: 'number' as const, description: `entries returned, across all providers (default ${DEFAULT_LIMIT})` },
  ],
  examples: [
    'news',
    'news --limit 20',
  ],
  returns: 'the newest entries of every news-* provider together: when, what, who did it, the node it is about, which provider, and the route that draws it.',
};
