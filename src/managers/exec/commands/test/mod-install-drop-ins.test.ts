/**
 * mod install and mod remove, and the services that read the modules' drop-ins (`dropIns`): a
 * module put in place with drop-ins new or changed restarts them once its drop-ins are linked, so
 * they read them; an update that leaves its drop-ins as they were leaves them running; and a module
 * removed restarts them without its own. Booted, so the services run.
 */

import { assert, assertEquals } from '@std/assert';
import { FakeForge, type Files, moduleFiles } from '../../../../testing/fake-forge.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const forge = new FakeForge();
const testCtx = createTestContext({ boot: true });
let client: ShellClient;

const run = async (command: string): Promise<string> => (await client.execString(`JSON_OUTPUT=0 ${command}`)).trim();

Deno.test({ name: 'mod-install drop-ins', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  forge.start();
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  try {
    await client.execString(`config set CFG_MODULE_SOURCES '${forge.url('acme')}'`);
    // `reader` reads /etc/tally.d as it starts, and says what it found there.
    await forge.publish('acme', 'module-reader', {
      ...moduleFiles('reader', '1.0.0', 'reader', { dropIns: { 'tally.d': { restarts: ['reader'] } } }),
      'services/reader/start.sh': { text: 'cat /etc/tally.d/*/kinds > /tmp/reader-saw; sleep 3600\n', mode: 0o755 },
    });
    await run('mod install reader');

    const writer = (version: string, says: string, kinds: string): Files => ({
      ...moduleFiles('writer', version, says),
      'etc/tally.d/kinds': `${kinds}\n`,
    });
    const restarted = (output: string) => output.includes("Restarted service 'reader'");
    /** What the reader found when it last started, once that is `expected` or a while has passed. */
    const saw = async (expected: string): Promise<string> => {
      let text = '';
      for (let i = 0; i < 50 && text !== expected; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
        text = String((await client.exec('JSON_OUTPUT=0 cat /tmp/reader-saw')).data ?? '').trim();
      }
      return text;
    };

    await t.step('a module new here with drop-ins restarts what reads them, after they are linked', async () => {
      await forge.publish('acme', 'module-writer', writer('1.0.0', 'writer 1', 'apples'));
      assert(restarted(await run('mod install writer')));
      assertEquals(await saw('apples'), 'apples');
    });

    await t.step('an update that leaves its drop-ins as they were does not; one that changes them does', async () => {
      await forge.publish('acme', 'module-writer', writer('1.0.1', 'writer 2', 'apples'));
      assertEquals(restarted(await run('mod install writer')), false);
      await forge.publish('acme', 'module-writer', writer('1.0.2', 'writer 2', 'pears'));
      assert(restarted(await run('mod install writer')));
      assertEquals(await saw('pears'), 'pears');
    });

    await t.step('a module removed restarts what read its drop-ins', async () => {
      assert(restarted(await run('mod-remove --force writer')));
    });
  } finally {
    client?.close();
    await testCtx.teardown();
    await forge.stop();
  }
});
