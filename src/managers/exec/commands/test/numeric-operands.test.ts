/**
 * Operands that look like numbers: a command that wants a number converts its operand itself, and
 * one that wants a name gets it exactly as written.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'numeric-looking operands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const run = async (line: string) => await client.execString(line, { json: false });

  try {
    await t.step('seq reads decimal, exponent and hex operands', async () => {
      assertEquals(await run('seq 3'), '1\n2\n3\n');
      assertEquals(await run('seq 08 10'), '8\n9\n10\n');
      assertEquals(await run('seq 1e1 11'), '10\n11\n');
      assertEquals(await run('seq 0x0f 0x10'), '15\n16\n');
      assertEquals(await run('seq 1 0.5 2'), '1\n1.5\n2\n');
    });

    await t.step('seq rejects an operand that is not a number', async () => {
      for (const operand of ["''", "' '", '5abc', 'x']) {
        const result = await client.exec(`seq ${operand}`, { json: false });
        assertEquals(result.success, false, operand);
        assertStringIncludes(result.error ?? '', 'seq: invalid number', operand);
      }
    });

    await t.step('a file named like a number is found by that name', async () => {
      await client.exec('mkdir -p /numeric-operands');
      await client.exec('seq 3 > /numeric-operands/007');
      await client.exec('seq 2 > /numeric-operands/1828138343960299923');

      assertEquals(await run('cd /numeric-operands && head -n 1 007'), '1\n');
      assertEquals(await run('cd /numeric-operands && tail -n 1 007'), '3\n');
      assertEquals(await run('cd /numeric-operands && cat 1828138343960299923'), '1\n2\n');
      assertEquals(await run('cd /numeric-operands && wc -l 007'), '3 007\n');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
