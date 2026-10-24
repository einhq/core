/**
 * API shell WebSocket exec: command output larger than the capture pipe
 * capacity (64KB) must be returned, not deadlock the exec, and `exec.cancel`
 * hangs up one running exec.
 */

import { assert, assertEquals, assertLess } from '@std/assert';
import { Shell } from '../../../managers/shell/shell.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { API_SHELL_EXEC_TIMEOUT_MS, API_SHELL_MAX_CAPTURE_BYTES } from '../ws/api-shell-handler.ts';

const harness = new SystemTestHarness({ ssh: false });

Deno.test({
  name: 'API shell exec',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  const shell = await harness.createShellClient();

  try {
    await t.step('allows corpus-sized UI mutations while retaining a deadline', () => {
      // Unknown-face merges can update 500+ VFS nodes serially; the deadline
      // leaves those valid commands room to finish.
      assertEquals(API_SHELL_EXEC_TIMEOUT_MS, 10 * 60_000);
    });

    await t.step('returns output larger than the capture pipe capacity', async () => {
      // seq 1 20000 emits ~108KB — well past the 64KB pipe capacity
      const out = await shell.execString('seq 1 20000');
      const lines = out.trimEnd().split('\n');
      assertEquals(lines.length, 20000);
      assertEquals(lines[0], '1');
      assertEquals(lines[lines.length - 1], '20000');
    });

    await t.step('rejects output above the shared capture ceiling and remains usable', async () => {
      const result = await shell.exec('seq 1 1000000');

      assertEquals(result.success, false);
      assertEquals((result.rawResponse as { code?: string }).code, 'OUTPUT_LIMIT_EXCEEDED');
      assert(result.error?.includes(`${API_SHELL_MAX_CAPTURE_BYTES}-byte output limit`));
      assertEquals(await shell.execString('echo still-alive'), 'still-alive\n');
    });

    await t.step('a failed script answers with its exit code and what it printed before the failing line', async () => {
      // The chat drawer runs a proposed change as one `set -e` script and shows the card what happened.
      const result = await shell.exec('set -e\n# a comment\necho before\nfalse\necho after');
      assertEquals(result.success, false);
      const raw = result.rawResponse as { exitCode?: number; output?: string; message?: string };
      assertEquals(raw.exitCode, 1);
      assertEquals(raw.output, 'before\n');
      assertEquals(await shell.execString('echo before\nfalse\necho after'), 'before\nafter\n');
    });

    await t.step('json: false runs the script as a terminal would, and hands back the text', async () => {
      // The same script, with and without JSON mode — the approval card wants what a person reads.
      const json = await shell.exec('mkdir -p /tmp/json-mode && echo $JSON_OUTPUT');
      assertEquals(json.success, true);
      const plain = await shell.exec('mkdir -p /tmp/text-mode && echo "[$JSON_OUTPUT]"', { json: false });
      assertEquals(plain.success, true);
      assertEquals(plain.data, '[]\n');
      // And the shell's own env is untouched by the run.
      assertEquals((await shell.exec('echo $JSON_OUTPUT')).data, 1);
      const failed = await shell.exec('echo out\nmkdir /tmp/text-mode/x/y', { json: false });
      assertEquals(failed.success, false);
      const raw = failed.rawResponse as { output?: string; stderr?: string; exitCode?: number };
      assertEquals(raw.output, 'out\n');
      assert(raw.stderr?.includes('Node not found: /tmp/text-mode/x'), raw.stderr);
      assertEquals(raw.exitCode, 1);
    });

    await t.step('stops a command at its deadline and leaves the shell reusable', async () => {
      const { sessionPath } = await harness.createHttpSession();
      const guardedShell = new Shell({
        cem: primary.cem,
        vfs: primary.vfs,
        bufferManager: primary.bufferManager,
        sessionPath,
        env: {},
      });
      await guardedShell.open();

      try {
        const concurrent = guardedShell.runAndCapture('sleep 0.15 && echo concurrent', undefined, {
          timeoutMs: 1000,
        });
        const started = Date.now();
        const result = await guardedShell.runAndCapture('sleep 5', undefined, {
          maxOutputBytes: 1024,
          timeoutMs: 50,
        });

        assertEquals(result.errorCode, 'EXEC_TIMEOUT');
        assert(result.stderr.includes('timed out after 50 ms'));

        // What the command wrote before the deadline is kept, ahead of the
        // verdict: a pipeline step stopped at its deadline has nothing else to
        // say about where it got to.
        const partial = await guardedShell.runAndCapture('echo got-here; echo phase-two >&2; sleep 5', undefined, {
          timeoutMs: 50,
        });
        assertEquals(partial.errorCode, 'EXEC_TIMEOUT');
        assertEquals(partial.stdout, 'got-here\n');
        assert(partial.stderr.startsWith('phase-two\n'), `expected the written stderr first, got ${JSON.stringify(partial.stderr)}`);
        assert(partial.stderr.endsWith('timed out after 50 ms'));
        assertLess(Date.now() - started, 1000);
        assertEquals((await concurrent).stdout, 'concurrent\n');
        assertEquals((await guardedShell.runAndCapture('echo reusable')).stdout, 'reusable\n');
      } finally {
        await guardedShell.close();
      }
    });

    await t.step('exec.cancel hangs up one running exec and leaves the others and the shell alone', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const cancelled = shell.exec('sleep 30; echo finished', { signal: controller.signal, timeout: 10_000 });
      const other = shell.exec('sleep 0.3; echo other', { timeout: 10_000 });
      setTimeout(() => controller.abort(), 100);

      const result = await cancelled;
      assertEquals(result.success, false);
      assertLess(Date.now() - started, 5000);
      const untouched = await other;
      assertEquals(untouched.success, true);
      assert(String(untouched.data).endsWith('other\n'), `the other exec ran to its end: ${JSON.stringify(untouched.data)}`);
      assertEquals(await shell.execString('echo still-alive'), 'still-alive\n');
    });

    await t.step('cancelling an exec that is not running says so', async () => {
      const raw = await shell.exec('true');
      assertEquals(raw.success, true);
      const ws = shell as unknown as { request: (payload: Record<string, unknown>) => Promise<{ data: unknown }> };
      assertEquals((await ws.request({ type: 'exec.cancel', params: ['req-gone'] })).data, { cancelled: false });
    });

    await t.step('survives rapid API and interactive socket teardown', async () => {
      const wsBase = primary.baseUrl.replace('http', 'ws');

      for (let i = 0; i < 4; i++) {
        const sockets = [
          new WebSocket(`${wsBase}/__shell`),
          new WebSocket(`${wsBase}/__shell?mode=interactive`),
        ];

        await Promise.all(sockets.map((socket) =>
          new Promise<void>((resolve, reject) => {
            socket.onopen = () => {
              socket.close();
              resolve();
            };
            socket.onerror = () => reject(new Error('rapid reconnect socket failed'));
          })
        ));
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(await shell.execString('echo connected'), 'connected\n');
    });
  } finally {
    shell.close();
    await harness.stop();
  }
});
