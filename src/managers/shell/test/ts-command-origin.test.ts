/**
 * Where a `#!ts` file may run from: a module's tree under `MOD_PATH` alone, whoever runs it. A
 * `#!ts` file anywhere else is refused with 126 before it is imported, so none of its code runs.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { MOD_PATH } from '../../../lib/paths.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext();

const MARK = '__tsCommandOriginRan';
const marks = (): string[] => ((globalThis as Record<string, unknown>)[MARK] ??= []) as string[];

/** A `#!ts` command whose top-level code leaves `label` in `globalThis[MARK]` when imported. */
const bin = (label: string) =>
  [
    '#!ts',
    `((globalThis as Record<string, unknown>).${MARK} as string[] | undefined)?.push('${label}');`,
    `const cmd = async (c: { writeLn(s: string): Promise<void> }) => { await c.writeLn('ran ${label}'); return 0; };`,
    `export default Object.assign(cmd, { spec: { name: '${label}', description: '${label}', effect: 'read' as const } });`,
  ].join('\n');

const write = async (client: ShellClient, path: string, body: string) => {
  await testCommands(client).shouldSucceed(`cat > ${path} <<'EOF'\n${body}\nEOF\nchmod 755 ${path}`);
};

/** Run `line`: its stdout and stderr, then `exit=<code>`. */
const run = async (client: ShellClient, line: string): Promise<string> => String((await client.exec(`${line} 2>&1; echo "exit=$?"`, { json: false })).data ?? '');

Deno.test({ name: '#!ts runs only from a module', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  marks().length = 0;

  try {
    await cmd.shouldSucceed('user-create eve');
    await cmd.shouldSucceed('user-passwd eve --new-password secret1');
    const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });

    try {
      await t.step("a #!ts file in the user's home is refused unrun", async () => {
        await write(eve, '/home/eve/x', bin('home'));

        const out = await run(eve, '/home/eve/x');
        assertStringIncludes(out, 'exit=126');
        assertStringIncludes(out, `a #!ts command runs only from a module in ${MOD_PATH}`);
        assertEquals(marks(), []);
      });

      await t.step('found on PATH, it is refused the same', async () => {
        await eve.exec('mkdir -p /home/eve/bin');
        await write(eve, '/home/eve/bin/mine', bin('path'));

        const out = await run(eve, 'PATH="$PATH:/home/eve/bin"; mine');
        assertStringIncludes(out, 'exit=126');
        assertEquals(marks(), []);
      });

      await t.step("pointing $MOD_PATH at the user's home does not make it a module", async () => {
        await eve.exec('mkdir -p /home/eve/mods/fake/bin');
        await write(eve, '/home/eve/mods/fake/mod.json', JSON.stringify({ name: 'fake', version: '0.1.0' }));
        await write(eve, '/home/eve/mods/fake/bin/fake', bin('env'));

        const out = await run(eve, 'MOD_PATH=/home/eve/mods /home/eve/mods/fake/bin/fake');
        assertStringIncludes(out, 'exit=126');
        assertEquals(marks(), []);
      });

      await t.step('the administrator is refused outside a module too', async () => {
        await write(admin, '/tmp/admin-x', bin('admin'));

        const out = await run(admin, '/tmp/admin-x');
        assertStringIncludes(out, 'exit=126');
        assertEquals(marks(), []);
      });

      await t.step("a module's #!ts bin runs for any user", async () => {
        const root = `${MOD_PATH}/origin-demo`;
        await cmd.shouldSucceed(`mkdir -p ${root}/bin`);
        await write(admin, `${root}/mod.json`, JSON.stringify({ name: 'origin-demo', version: '0.1.0' }));
        await write(admin, `${root}/bin/origin-demo`, bin('module'));

        const out = await run(eve, `${root}/bin/origin-demo`);
        assertStringIncludes(out, 'ran module');
        assertStringIncludes(out, 'exit=0');
        assertEquals(marks(), ['module']);
      });
    } finally {
      eve.close();
    }
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
