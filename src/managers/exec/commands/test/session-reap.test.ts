/**
 * session-reap tests: which session and tty nodes count as stale, and which are
 * pinned by a live shell.
 *
 * The shell client running these steps has its own live session and tty under
 * /sessions, so every assertion is about a named path rather than a total —
 * and the fact that it survives is itself part of what is being tested.
 */

import { SESSIONS_PATH } from '../../../../lib/paths.ts';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { BOOT_ID } from '../../../../lib/boot-id/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../vfs/types/session.ts';
import { NODE_TYPE_TTY, type TtyAttrs } from '../../../../vfs/types/tty.ts';
import type { NodeVFS } from '../../../../vfs/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';

// No boot: a booted instance runs the session-reaper service, whose boot sweep
// could land between the fixture and `--dry-run` and remove the sessions it is
// about to report. The command under test is core and needs no service.
const testCtx = createTestContext();

const SESSIONS = SESSIONS_PATH;
const HOUR = 3_600_000;

type ReapResult = { sessions: number; ttys: number; scanned: number; capped: boolean; dryRun: boolean };

async function makeSession(vfs: NodeVFS, name: string, attrs: Partial<SessionAttrs>): Promise<string> {
  await vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, SESSIONS, name, {
    props: { mode: 0o700 },
    attrs: {
      secret: 'secret',
      access: ADMIN_ACCESS,
      env: {},
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ...attrs,
    },
  });
  return `${SESSIONS}/${name}`;
}

async function makeTty(vfs: NodeVFS, sessionPath: string, name: string, bootId: string): Promise<void> {
  await vfs.create<TtyAttrs>(ADMIN_ACCESS, NODE_TYPE_TTY, sessionPath, name, {
    attrs: {
      createdAt: Date.now(),
      lastActivity: Date.now(),
      bootId,
      access: ADMIN_ACCESS,
      env: {},
      params: {},
      cwd: '/',
      rows: 24,
      cols: 80,
    },
  });
}

Deno.test({
  name: 'session-reap',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const vfs = ctx.vfs;

  const exists = (path: string) => vfs.exists(ADMIN_ACCESS, path);

  try {
    const now = Date.now();

    // Bound to a process that is gone.
    const deadBoot = await makeSession(vfs, 'session-dead-boot', { bootId: 'OTHERBOOT' });
    // Bound to this process — an SSH channel or WS shell that is still open.
    const liveBoot = await makeSession(vfs, 'session-live-boot', { bootId: BOOT_ID });
    // Cookie-backed, past its expiry.
    const expired = await makeSession(vfs, 'session-expired', { expiresSec: 60, lastActivity: now - HOUR });
    // Cookie-backed, still inside it.
    const fresh = await makeSession(vfs, 'session-fresh', { expiresSec: 12 * 3600, lastActivity: now });
    // Explicitly marked.
    const flagged = await makeSession(vfs, 'session-flagged', { expiresSec: 12 * 3600, expired: true });
    // Neither stamp nor expiry.
    const legacyOld = await makeSession(vfs, 'session-legacy-old', { lastActivity: now - 25 * HOUR });
    const legacyNew = await makeSession(vfs, 'session-legacy-new', { lastActivity: now });

    // Expired, but an open shell is attached — plus a stranded tty beside it.
    const pinned = await makeSession(vfs, 'session-pinned', { expiresSec: 60, lastActivity: now - HOUR });
    await makeTty(vfs, pinned, 'tty-live', BOOT_ID);
    await makeTty(vfs, pinned, 'tty-dead', 'OTHERBOOT');

    await t.step('--dry-run reports without removing', async () => {
      const result = await client.execJson<ReapResult>('session-reap --dry-run');

      assertEquals(result.dryRun, true);
      assert(result.sessions >= 4, `expected at least 4 stale sessions, got ${result.sessions}`);
      assertEquals(await exists(deadBoot), true);
      assertEquals(await exists(expired), true);
    });

    await t.step('--max bounds a single pass', async () => {
      const result = await client.execJson<ReapResult>('session-reap --max 1');

      assertEquals(result.sessions + result.ttys, 1);
      assertEquals(result.capped, true);
    });

    await t.step('removes stale sessions and keeps the rest', async () => {
      // --max above removed one of them already; keep going until it converges.
      for (let i = 0; i < 10; i++) {
        const result = await client.execJson<ReapResult>('session-reap');
        if (!result.capped && result.sessions === 0 && result.ttys === 0) break;
      }

      assertEquals(await exists(deadBoot), false, 'session from a previous boot survived');
      assertEquals(await exists(expired), false, 'session past expiresSec survived');
      assertEquals(await exists(flagged), false, 'session marked expired survived');
      assertEquals(await exists(legacyOld), false, 'unstamped session older than --stale survived');

      assertEquals(await exists(liveBoot), true, 'session from this boot was reaped');
      assertEquals(await exists(fresh), true, 'session inside its expiry was reaped');
      assertEquals(await exists(legacyNew), true, 'recent unstamped session was reaped');
    });

    await t.step('a live tty pins its session past expiry', async () => {
      assertEquals(await exists(pinned), true, 'session with a live shell was reaped');
      assertEquals(await exists(`${pinned}/tty-live`), true, 'live tty was reaped');
      assertEquals(await exists(`${pinned}/tty-dead`), false, 'stranded tty survived');
    });

    await t.step('--stale accepts a duration and rejects nonsense', async () => {
      const result = await client.execJson<ReapResult>('session-reap --stale 1ms');
      assertEquals(await exists(legacyNew), false, 'a short --stale did not reach a recent unstamped session');
      assertEquals(result.dryRun, false);

      const bad = await client.exec('session-reap --stale banana');
      assertEquals(bad.success, false);
    });

    await t.step('the shell running this test survived every pass', async () => {
      const result = await client.exec('echo alive');
      assertEquals(result.success, true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
