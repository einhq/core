import { resolve } from '@std/path';
import { ACCESS_EVENTS, type AccessEvent, type AccessLogEntry, type AccessLogQuery } from '../../../../lib/api/audit.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { SYSTEM_TIME_ZONE } from '../../../../lib/datetime/timezone.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** Epoch milliseconds, or anything `Date` parses (`2026-09-27`, `2026-09-27T12:00`). */
const parseTime = (value: string): number | undefined => {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

/** `YYYY-MM-DD HH:MM:SS` in the deployment's zone, as the rest of the shell shows time. */
const formatTime = (ms: number): string => new Date(ms).toLocaleString('sv-SE', { timeZone: SYSTEM_TIME_ZONE });

/** What a record is about besides who and how: the path, the link, the count, the reason. */
const subject = (e: AccessLogEntry): string =>
  [
    e.path,
    e.count !== undefined && `(${e.count} files)`,
    e.linkId && `link ${e.linkId}`,
    e.method,
    e.reason && `— ${e.reason}`,
  ].filter(Boolean).join(' ');

export const accessLog = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['user', 'event', 'sid', 'from', 'link', 'record', 'since', 'until', 'n', 'after'],
    collect: ['event'],
  });

  const fail = async (message: string): CmdReturn => {
    if (cmd.json) await cmd.writeJSON({ error: `access-log: ${message}` });
    else await cmd.writeError(`access-log: ${message}\n`);
    return 1;
  };

  // Names both ways: `--user` in, and every record's uid out. Accounts are few; one listing serves both.
  const users = await cmd.sys.vfs.children<UserAttrs>(ADMIN_ACCESS, cmd.env.USERS_PATH).catch(() => []);
  const usernames = new Map(users.map((u) => [u.node.attrs.uid, u.name]));

  const query: AccessLogQuery = {};

  if (flags._[0] !== undefined) query.pathPrefix = resolve(cmd.cwd, String(flags._[0]));
  if (flags.record) query.id = flags.record;
  if (flags.sid) query.sid = flags.sid;
  if (flags.from) query.from = flags.from;
  if (flags.link) query.linkId = flags.link;
  if (flags.after) query.after = flags.after;

  const events = (Array.isArray(flags.event) ? flags.event : flags.event === undefined ? [] : [flags.event]).map(String).filter((event) => event !== '');
  for (const event of events) {
    if (!ACCESS_EVENTS.includes(event as AccessEvent)) return await fail(`unknown event '${event}' (one of ${ACCESS_EVENTS.join(', ')})`);
  }
  if (events.length > 0) query.events = events as AccessEvent[];

  if (flags.user) {
    const uid = /^\d+$/.test(flags.user) ? Number(flags.user) : users.find((u) => u.name === flags.user)?.node.attrs.uid;
    if (uid === undefined) return await fail(`unknown user '${flags.user}'`);
    query.uid = uid;
  }

  for (const key of ['since', 'until'] as const) {
    if (!flags[key]) continue;
    const ms = parseTime(flags[key]);
    if (ms === undefined) return await fail(`cannot parse --${key} '${flags[key]}'`);
    query[key] = ms;
  }

  if (flags.n) {
    const limit = Number(flags.n);
    if (!Number.isInteger(limit) || limit < 1) return await fail(`-n must be a positive integer`);
    query.limit = limit;
  }

  let entries: AccessLogEntry[];
  try {
    entries = (await cmd.sys.vfs.accessLog(cmd.access, query)).map((r) => {
      const username = r.uid !== undefined ? usernames.get(r.uid) : undefined;
      return username ? { ...r, username } : r;
    });
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies AccessLogEntry[]);
    return 0;
  }

  // Oldest first on a terminal, like a log; the query itself is newest first so `-n` keeps the
  // latest, unless it reads forward from `--after`.
  for (const e of query.after !== undefined ? entries : entries.toReversed()) {
    const who = e.username ?? (e.uid !== undefined ? `uid:${e.uid}` : '-');
    const where = [e.via, e.from].filter(Boolean).join(' ');
    await cmd.write(`${formatTime(e.timestamp)}  ${who.padEnd(10)} ${e.event.padEnd(16)} ${where.padEnd(22)} ${subject(e)}\n`);
  }

  return 0;
};

accessLog.spec = {
  name: 'access-log',
  admin: true,
  effect: 'read' as const,
  description: 'Show who signed in or out, opened a share link or downloaded what, from where, and when (administrators only)',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'only downloads and share links of this path or below it',
    },
  ],
  flags: [
    { name: 'user', type: 'string' as const, description: 'only events of this user (name or uid)' },
    { name: 'event', type: 'string' as const, description: `only this event (repeatable): ${ACCESS_EVENTS.join(', ')}` },
    { name: 'sid', type: 'string' as const, description: 'only events of this session or SSH connection, as `audit -v` shows it' },
    { name: 'from', type: 'string' as const, description: 'only events from this client address' },
    { name: 'link', type: 'string' as const, description: 'only events through this share link (its id)' },
    { name: 'record', type: 'string' as const, description: 'only the record with this id' },
    { name: 'since', type: 'string' as const, description: 'from this time on (ISO date/time or epoch ms)' },
    { name: 'until', type: 'string' as const, description: 'before this time (ISO date/time or epoch ms)' },
    {
      name: 'after',
      type: 'string' as const,
      description: 'only the records after this record id, oldest first: pass the last id read to follow the log',
    },
    { name: 'n', type: 'string' as const, description: 'at most this many records, the latest, or with --after the first (default: 100)' },
  ],
  examples: [
    'access-log --event sign-in-failed --since 2026-11-01',
    'access-log /archive --event download --event download-archive',
    'access-log --user anna -n 20',
  ],
};
