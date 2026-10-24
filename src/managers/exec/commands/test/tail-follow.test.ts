/**
 * tail -f (follow) for log and file nodes. The API shell returns one result
 * per command and can't drive a blocking follow, so this exercises the tail
 * command function directly against a test VFS with a lightweight Command and
 * a manual interrupt.
 *
 * Log follow rides the log's blocking read (waiter wakeup); file follow rides
 * the 'updated' event emitted by write-time size tracking.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestVfs } from '../../../../testing/mod.ts';
import type { LocalNodeVFS } from '../../../../vfs/mod.ts';
import type { Command } from '../../command.ts';
import { tail } from '../utils/tail.ts';

const enc = new TextEncoder();

function makeCmd(vfs: LocalNodeVFS, args: string[]) {
  const chunks: string[] = [];
  let handler: (() => void) | null = null;
  let interrupted = false;

  const cmd = {
    sys: { vfs },
    access: ADMIN_ACCESS,
    cwd: '/',
    args,
    get interrupted() {
      return interrupted;
    },
    write: (d: string) => {
      chunks.push(d);
      return Promise.resolve();
    },
    writeError: (d: string) => {
      chunks.push(d);
      return Promise.resolve();
    },
    onInterrupt: (h: (() => void) | null) => {
      handler = h;
    },
  } as unknown as Command;

  return {
    cmd,
    output: () => chunks.join(''),
    interrupt: () => {
      interrupted = true;
      handler?.();
    },
  };
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const appendLog = async (vfs: LocalNodeVFS, path: string, data: unknown) => {
  const h = await vfs.open(ADMIN_ACCESS, path, { mode: 'a' });
  await h.write(enc.encode(JSON.stringify(data) + '\n'));
  await h.close();
};

Deno.test({ name: 'tail -f follow', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await t.step('log: streams history then live appends, stops on interrupt', async () => {
      await vfs.create(ADMIN_ACCESS, 'log', '/', 'mylog');
      await appendLog(vfs, '/mylog', { value: 1 });
      await appendLog(vfs, '/mylog', { value: 2 });

      const m = makeCmd(vfs, ['-f', '/mylog']);
      const p = tail(m.cmd);

      // History
      await waitFor(() => m.output().includes('"value":1') && m.output().includes('"value":2'));

      // Live append
      await appendLog(vfs, '/mylog', { value: 3 });
      await waitFor(() => m.output().includes('"value":3'));

      // Service stdout/stderr are stored as JSON strings, but an interactive
      // tail should look like the original text stream rather than quoted JSON.
      await appendLog(vfs, '/mylog', 'plain log line');
      await waitFor(() => m.output().includes('plain log line\n'));
      assertEquals(m.output().includes('"plain log line"'), false);

      m.interrupt();
      assertEquals(await p, 130);
    });

    await t.step('file: streams tail then live appends, stops on interrupt', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'f.txt', {
        attrs: { name: 'f.txt', mimetype: 'text/plain', size: 0 },
      });
      {
        const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'w' });
        await h.write(enc.encode('a\nb\nc\n'));
        await h.close();
      }

      const m = makeCmd(vfs, ['-f', '/f.txt']);
      const p = tail(m.cmd);

      // History (last lines)
      await waitFor(() => m.output().includes('a') && m.output().includes('c'));

      // Append — close emits 'updated', which the follow subscription pumps
      {
        const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'a' });
        await h.write(enc.encode('d\n'));
        await h.close();
      }
      await waitFor(() => m.output().includes('d'));

      m.interrupt();
      assertEquals(await p, 130);
    });
  } finally {
    await ctx.dispose();
  }
});
