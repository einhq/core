/**
 * Group-command dispatch: `pipeline <x>` routes to `pipeline-<x>` by string
 * prefixing, but never to a long-running daemon: `pipeline engine` must not
 * start a second engine in the caller's session against the same queue.
 *
 * Two independent guards, both covered here: the dispatcher refuses to route to
 * a `daemon: true` spec, and the engine itself refuses a peer on its queue.
 */

import { PIPELINE_QUEUE_PATH } from '../../../../lib/paths.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { SystemTestHarness } from '../../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({
  name: 'group dispatch',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.startPrimary();
  const client = await harness.createShellClient();

  try {
    await t.step('refuses to route a group subcommand to a daemon', async () => {
      const result = await client.exec('pipeline engine');
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', "'engine' is a long-running daemon");
      assertStringIncludes(result.error ?? '', 'service start pipeline-engine');
    });

    await t.step('names the right service for each daemon', async () => {
      const result = await client.exec('pipeline worker');
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', 'service start pipeline-worker');
    });

    await t.step('still routes ordinary subcommands', async () => {
      const result = await client.exec('pipeline list');
      assertEquals(result.success, true, `pipeline list failed: ${result.error}`);
    });

    await t.step('passes argument values through literally', async () => {
      // The argument arrives whole, `$b` included, not expanded a second time.
      const result = await client.exec("pipeline status 'a$b'");
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', "instance 'a$b' not found");
    });

    await t.step('a second engine on the same queue refuses to start', async () => {
      // Reachable directly, though the dispatcher does not route to it.
      // Must fail fast rather than run alongside the booted engine service.
      const result = await client.exec('pipeline-engine');
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', `already running on ${PIPELINE_QUEUE_PATH}`);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
