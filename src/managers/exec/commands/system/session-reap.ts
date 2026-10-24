/**
 * session-reap — collect session and tty nodes nobody owns any more.
 *
 * Both node types are removed on a clean shutdown path; this collects whatever
 * skipped one, which would otherwise stay forever.
 *
 * The interesting part is telling stale from active, because timestamps cannot.
 * A tty is live if and only if the process that opened it is still running, so
 * `Shell.open` stamps it with `BOOT_ID` and any other value means the shell died
 * with its process. Sessions get the same stamp when they are reachable only
 * through this process (an SSH channel, a WebSocket that could not hand its
 * client a cookie); a cookie-backed HTTP session deliberately has none, because
 * it is supposed to survive a restart, and is aged out on `expiresSec` instead.
 *
 * A session holding a live tty is never removed whatever its clock says — a
 * browser can sit on an interactive shell for a day without making a single
 * HTTP request, and `lastActivity` would have expired it out from under the
 * open terminal.
 */

import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { BOOT_ID } from '../../../../lib/boot-id/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../vfs/types/session.ts';
import { NODE_TYPE_TTY, type TtyAttrs } from '../../../../vfs/types/tty.ts';
import { parseDuration } from '../pool/lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * How old a session carrying neither stamp nor expiry has to be before it is
 * treated as garbage. Nothing else tells such a node from one created a second
 * ago, so age is the only safe discriminator, and the default is generous.
 */
const DEFAULT_STALE_MS = 24 * 3_600_000;

/** Deletions per run, so a first pass over a large /sessions cannot monopolise the database. */
const DEFAULT_MAX = 1000;

type Reaped = {
  sessions: number;
  ttys: number;
  scanned: number;
  /** True when --max stopped the sweep before the end of the directory. */
  capped: boolean;
};

export const sessionReap = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['path', 'max', 'stale'],
    boolean: ['dry-run'],
  });

  const sessionsPath = flags.path || cmd.env.SESSIONS_PATH;

  if (!sessionsPath) {
    await cmd.writeError('session-reap: no sessions path (set SESSIONS_PATH or pass --path)\n');
    return 1;
  }

  const max = flags.max === undefined ? DEFAULT_MAX : Number(flags.max);

  if (!Number.isInteger(max) || max < 0) {
    await cmd.writeError(`session-reap: invalid --max '${flags.max}' (expected a non-negative integer)\n`);
    return 1;
  }

  let staleMs: number;
  try {
    staleMs = parseDuration(flags.stale, '--stale') ?? DEFAULT_STALE_MS;
  } catch (error) {
    await cmd.writeError(`session-reap: ${(error as Error).message}\n`);
    return 1;
  }

  const dryRun = Boolean(flags['dry-run']);
  const now = Date.now();
  const result: Reaped = { sessions: 0, ttys: 0, scanned: 0, capped: false };

  let sessions;
  try {
    sessions = await cmd.sys.vfs.children<SessionAttrs>(ADMIN_ACCESS, sessionsPath);
  } catch (error) {
    await cmd.writeError(`session-reap: cannot read ${sessionsPath}: ${(error as Error).message}\n`);
    return 1;
  }

  for (const entry of sessions) {
    if (result.sessions + result.ttys >= max) {
      result.capped = true;
      break;
    }

    // Anything else under here belongs to somebody else; leave it alone.
    if (entry.node.type !== NODE_TYPE_SESSION) {
      continue;
    }

    result.scanned++;

    const sessionPath = join(sessionsPath, entry.name);
    const ttys = await liveAndDeadTtys(cmd, sessionPath);

    // A live tty pins its session regardless of expiry, and its siblings are
    // removed individually rather than with the session.
    if (ttys.live > 0) {
      for (const name of ttys.dead) {
        if (result.sessions + result.ttys >= max) {
          result.capped = true;
          break;
        }
        if (!dryRun) {
          await unlink(cmd, join(sessionPath, name), sessionPath);
        }
        result.ttys++;
      }
      continue;
    }

    if (!isStale(entry.node.attrs, now, staleMs)) {
      // Not collectable yet, but its stranded ttys are.
      for (const name of ttys.dead) {
        if (result.sessions + result.ttys >= max) {
          result.capped = true;
          break;
        }
        if (!dryRun) {
          await unlink(cmd, join(sessionPath, name), sessionPath);
        }
        result.ttys++;
      }
      continue;
    }

    if (!dryRun) {
      await unlink(cmd, sessionPath, sessionsPath, true);
    }
    result.sessions++;
    result.ttys += ttys.dead.length;
  }

  if (cmd.json) {
    await cmd.writeJSON({ ...result, dryRun });
    return 0;
  }

  await cmd.write(
    `${dryRun ? 'Would reap' : 'Reaped'} ${result.sessions} session(s) and ${result.ttys} tty node(s) ` +
      `of ${result.scanned} scanned${result.capped ? ' (stopped at --max)' : ''}\n`,
  );
  return 0;
};

/** Split a session's tty children into live (this boot) and dead (any other). */
async function liveAndDeadTtys(cmd: Command, sessionPath: string): Promise<{ live: number; dead: string[] }> {
  let children;
  try {
    children = await cmd.sys.vfs.children<TtyAttrs>(ADMIN_ACCESS, sessionPath);
  } catch {
    return { live: 0, dead: [] };
  }

  let live = 0;
  const dead: string[] = [];

  for (const child of children) {
    if (child.node.type !== NODE_TYPE_TTY) {
      continue;
    }
    // A tty without this process's stamp was opened by another process: this
    // one always stamps.
    if (child.node.attrs.bootId === BOOT_ID) {
      live++;
    } else {
      dead.push(child.name);
    }
  }

  return { live, dead };
}

function isStale(attrs: SessionAttrs, now: number, staleMs: number): boolean {
  if (attrs.expired) {
    return true;
  }

  // Bound to a process that is gone.
  if (attrs.bootId) {
    return attrs.bootId !== BOOT_ID;
  }

  const seen = attrs.lastActivity || attrs.createdAt || 0;

  if (attrs.expiresSec) {
    return now - seen > attrs.expiresSec * 1000;
  }

  // Neither stamp nor expiry: aged out on its last activity.
  return now - seen > staleMs;
}

async function unlink(cmd: Command, path: string, parent: string, recursive = false): Promise<void> {
  try {
    await cmd.sys.vfs.unlink(ADMIN_ACCESS, path, parent, { recursive, readlink: true });
  } catch {
    // Raced with a clean close, or already gone. Either way there is nothing left to do.
  }
}

sessionReap.spec = {
  name: 'session-reap',
  admin: true,
  effect: 'write' as const,
  description: 'Remove session and tty nodes left behind by dead shells',
  flags: [
    { name: 'path', type: 'string' as const, description: 'Sessions directory (default $SESSIONS_PATH)' },
    { name: 'max', type: 'string' as const, description: `Stop after removing this many nodes (default ${DEFAULT_MAX})` },
    { name: 'stale', type: 'string' as const, description: 'Age at which an unstamped session is collectable (default 24h)' },
    { name: 'dry-run', dryRun: true, type: 'bool' as const, description: 'Report what would be removed without removing it' },
  ],
};
