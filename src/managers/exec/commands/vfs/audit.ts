import { resolve } from '@std/path';
import type { AuditChange, AuditEntry, AuditOp, AuditQuery } from '../../../../lib/api/audit.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { SYSTEM_TIME_ZONE } from '../../../../lib/datetime/timezone.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const OPS: readonly AuditOp[] = ['create', 'update', 'move', 'link', 'unlink', 'delete'];

/** Epoch milliseconds, or anything `Date` parses (`2026-09-27`, `2026-09-27T12:00`). */
const parseTime = (value: string): number | undefined => {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

/** `YYYY-MM-DD HH:MM:SS` in the deployment's zone, as the rest of the shell shows time. */
const formatTime = (ms: number): string => new Date(ms).toLocaleString('sv-SE', { timeZone: SYSTEM_TIME_ZONE });

const formatValue = (name: string, value: unknown): string => {
  if (value === undefined) return '∅';
  if (name === 'mode' && typeof value === 'number') return `0${value.toString(8)}`;
  return JSON.stringify(value);
};

const formatChanges = (changes: Record<string, AuditChange> | undefined): string[] =>
  Object.entries(changes ?? {}).map(([name, c]) => `${name}: ${formatValue(name, c.from)} → ${formatValue(name, c.to)}`);

export const audit = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['user', 'id', 'record', 'cause', 'op', 'since', 'until', 'n', 'after', 'type'],
    collect: ['type'],
    boolean: ['v'],
  });

  const fail = async (message: string): CmdReturn => {
    if (cmd.json) await cmd.writeJSON({ error: `audit: ${message}` });
    else await cmd.writeError(`audit: ${message}\n`);
    return 1;
  };

  // Names both ways: `--user` in, and every record's uid out. Accounts are few; one listing serves both.
  const users = await cmd.sys.vfs.children<UserAttrs>(ADMIN_ACCESS, cmd.env.USERS_PATH).catch(() => []);
  const usernames = new Map(users.map((u) => [u.node.attrs.uid, u.name]));

  const query: AuditQuery = {};

  if (flags._[0] !== undefined) query.pathPrefix = resolve(cmd.cwd, String(flags._[0]));
  if (flags.id) query.nodeId = flags.id;
  if (flags.record) query.id = flags.record;
  if (flags.cause) query.cause = flags.cause;
  if (flags.after) query.after = flags.after;
  const types = (Array.isArray(flags.type) ? flags.type : flags.type === undefined ? [] : [flags.type]).map(String).filter((type) => type !== '');
  if (types.length > 0) query.nodeTypes = types;

  if (flags.user) {
    const uid = /^\d+$/.test(flags.user) ? Number(flags.user) : users.find((u) => u.name === flags.user)?.node.attrs.uid;
    if (uid === undefined) return await fail(`unknown user '${flags.user}'`);
    query.uid = uid;
  }

  if (flags.op) {
    if (!OPS.includes(flags.op as AuditOp)) return await fail(`unknown op '${flags.op}' (one of ${OPS.join(', ')})`);
    query.op = flags.op as AuditOp;
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

  let entries: AuditEntry[];
  try {
    entries = (await cmd.sys.vfs.audit(cmd.access, query)).map((r) => {
      const username = usernames.get(r.uid);
      return username ? { ...r, username } : r;
    });
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }

  if (cmd.json) {
    await cmd.writeJSON(entries satisfies AuditEntry[]);
    return 0;
  }

  // Oldest first on a terminal, like a log; the query itself is newest first so `-n` keeps the
  // latest, unless it reads forward from `--after`.
  for (const e of query.after !== undefined ? entries : entries.toReversed()) {
    const who = e.username ?? `uid:${e.uid}`;
    const where = e.fromPath ? `${e.fromPath} → ${e.path}` : e.path;
    await cmd.write(`${formatTime(e.timestamp)}  ${who.padEnd(10)} ${e.op.padEnd(7)} ${e.nodeType.padEnd(10)} ${where}\n`);

    if (flags.v) {
      const origin = [`record ${e.id}`, e.sid && `sid ${e.sid}`, e.cause && `cause ${e.cause}`].filter(Boolean).join('  ');
      for (const line of [origin, ...formatChanges(e.props), ...formatChanges(e.attrs)]) {
        await cmd.write(`    ${line}\n`);
      }
    }
  }

  return 0;
};

audit.spec = {
  name: 'audit',
  admin: true,
  effect: 'read' as const,
  description: 'Show who created, changed, moved, linked or removed which node, and when (administrators only)',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'only writes to this path or below it (moves match on either side)',
    },
  ],
  flags: [
    { name: 'user', type: 'string' as const, description: 'only writes by this user (name or uid)' },
    { name: 'id', type: 'string' as const, description: 'only writes to this node id' },
    { name: 'record', type: 'string' as const, description: 'only the record with this id' },
    {
      name: 'cause',
      type: 'string' as const,
      description: 'only writes set off by the write with this record id: what its pipeline runs wrote',
    },
    { name: 'op', type: 'string' as const, description: `only this operation: ${OPS.join(', ')}` },
    { name: 'since', type: 'string' as const, description: 'from this time on (ISO date/time or epoch ms)' },
    { name: 'until', type: 'string' as const, description: 'before this time (ISO date/time or epoch ms)' },
    { name: 'type', type: 'string' as const, description: 'only writes to nodes of this type (repeatable)' },
    {
      name: 'after',
      type: 'string' as const,
      description: 'only the records after this record id, oldest first: pass the last id read to follow the trail',
    },
    { name: 'n', type: 'string' as const, description: 'at most this many records, the latest, or with --after the first (default: 100)' },
    { name: 'v', type: 'bool' as const, description: "show each record's id, session or pipeline run, cause, and the values it changed" },
  ],
};
