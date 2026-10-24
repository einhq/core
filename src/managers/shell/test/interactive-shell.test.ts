import { assertEquals, assertLess } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { InteractiveShell } from '../interactive-shell.ts';

const TIMEOUT_MS = 5000;

const withTimeout = async (promise: Promise<number>, label: string): Promise<number> => {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish within ${TIMEOUT_MS}ms`)), TIMEOUT_MS));
  return await Promise.race([promise, timer]);
};

Deno.test({
  name: 'interactive shell exits its loop when the fds go away',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();

    const createShell = async () => {
      const { sessionPath } = await harness.createHttpSession();
      const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });
      await shell.open();
      return shell;
    };

    await t.step('close() while parked in readline ends runInteractive', async () => {
      const shell = await createShell();
      const running = shell.runInteractive();

      // Let readline park on stdin before pulling the rug out.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await shell.close();

      assertEquals(await withTimeout(running, 'runInteractive'), 0);
    });

    await t.step('a missing stdin does not spin the loop', async () => {
      const shell = await createShell();

      // Teardown that did not go through close(): the loop ends rather than
      // retrying on a stdin that is gone.
      await shell.pipeRemove('0');

      const started = Date.now();
      assertEquals(await withTimeout(shell.runInteractive(), 'runInteractive'), 0);
      assertLess(Date.now() - started, 1000);

      await shell.close();
    });

    await harness.stop();
  },
});
