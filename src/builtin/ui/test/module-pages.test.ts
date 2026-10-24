/**
 * Every module in the checkout that carries routes bundles with `ui-build`: a page that imports
 * something the shell does not lend fails here, not on the first visit to it. Nothing to bundle
 * without such a module.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import { repoModules } from '../../../modules/repo.ts';

const withPages: string[] = [];
for (const { name, dir } of repoModules()) {
  try {
    const manifest = JSON.parse(await Deno.readTextFile(`${dir}/mod.json`)) as { ui?: { routes?: Record<string, string> } };
    if (manifest.ui?.routes) withPages.push(name);
  } catch {
    // not a module
  }
}
withPages.sort();

const testCtx = createTestContext({ modules: withPages });

Deno.test({ name: 'module pages bundle', ignore: withPages.length === 0, sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  try {
    const result = await client.exec(`ui-build ${withPages.join(' ')}`);
    assertEquals(result.success, true, result.error);
    const { modules } = result.data as { modules: Record<string, { state: string }> };
    assertEquals(Object.fromEntries(Object.entries(modules).map(([name, outcome]) => [name, outcome.state])), Object.fromEntries(withPages.map((name) => [name, 'built'])));
  } finally {
    await testCtx.teardown();
  }
});
