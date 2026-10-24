/**
 * A prefix assignment reaches a bin written in bash, as it reaches one in TypeScript:
 * `JSON_OUTPUT=1 mkfile --help` answers in JSON when the caller is in text mode. The prefix is a
 * shell variable, and a bash bin's `arg` reads only the environment.
 */

import { assert } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({ name: 'bash bin sees prefix assignments', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  try {
    await t.step('JSON_OUTPUT=1 before a bash bin, from a caller in text mode', async () => {
      const dir = `/tmp/prefix-env-${crypto.randomUUID()}`;
      // The caller is in text mode; only the prefix asks for JSON.
      await client.exec(`mkdir -p ${dir} && printf '#!bash\\nexport JSON_OUTPUT=0\\nJSON_OUTPUT=1 mkfile --help\\n' > ${dir}/probe && chmod 755 ${dir}/probe`);
      const printed = (await client.exec(`${dir}/probe`)).data;
      // The client hands back JSON parsed; text help stays a string.
      assert(typeof printed === 'object' && (printed as { name?: string }).name === 'mkfile', String(printed).slice(0, 80));
    });
  } finally {
    await testCtx.teardown();
  }
});
