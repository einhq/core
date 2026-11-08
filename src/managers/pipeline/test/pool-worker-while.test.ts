/**
 * `pipeline-worker --while`: the worker runs while a command succeeds, and stops, saying why, once
 * it fails; `--env` is checked as it is parsed.
 */

import { assertStringIncludes } from '@std/assert';
import { POOLS_PATH } from '../../../lib/paths.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({ name: 'pipeline-worker --while', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await harness.start();
  const client = await harness.createShellClient();
  try {
    await t.step('the worker stops once its condition fails', async () => {
      const out = await client.execString(
        `mkfile /tmp/keep-working && (sleep 0.6; rm /tmp/keep-working) & ` +
          `pipeline-worker --pool ${POOLS_PATH}/while-pool --env CFG_EMS_INSTANCE=laptop --while 'test -e /tmp/keep-working' --while-every 0.2`,
      );
      assertStringIncludes(out, 'Pipeline worker stopped: test -e /tmp/keep-working exited 1');
    });

    await t.step('--env takes NAME=value', async () => {
      const result = await client.exec(`pipeline-worker --pool ${POOLS_PATH}/while-pool --env laptop`);
      assertStringIncludes(String(result.error), "--env takes NAME=value, not 'laptop'");
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
