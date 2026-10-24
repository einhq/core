/**
 * The module contract stays small — asserted on its import graph, not on what it exports.
 *
 * A narrow surface can still have the whole of core behind it (pg and ssh2 among it): a contract
 * *type* that imports `command.ts`, or a registry barrel that re-exports its PostgreSQL
 * implementation, ships all of that with the contract. A
 * module type-checks against that graph, and it is what a published package would have to carry,
 * so the graph is the thing to hold still. `@ein/testing` is exempt: it boots a real system.
 */

import { assertEquals } from '@std/assert';
import { fromFileUrl, relative } from '@std/path';

const REPO_ROOT = fromFileUrl(new URL('../../../', import.meta.url));
const CONTRACT = fromFileUrl(new URL('../mod.ts', import.meta.url));

/** Room to grow, and far below the whole of core. */
const MAX_CORE_FILES = 100;

/** Parts of core the contract must never reach, whatever the count. */
const FORBIDDEN = [
  /^src\/managers\/exec\/(commands|exec-manager|execution-manager|cmd)\b/,
  /^src\/system-core\.ts$/,
  /^src\/(servers|stores)\//,
  /^src\/registries\/[^/]+\/(pg-|memory-|.*-registry\.ts$)/,
];

Deno.test('the module contract reaches a small part of core and no npm package', async () => {
  const output = await new Deno.Command(Deno.execPath(), { args: ['info', '--json', CONTRACT], stdout: 'piped', stderr: 'null' }).output();
  assertEquals(output.success, true, 'deno info failed');
  const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as { modules: { specifier: string }[] };

  const core = graph.modules
    .map((mod) => mod.specifier)
    .filter((specifier) => specifier.startsWith('file://'))
    .map((specifier) => relative(REPO_ROOT, fromFileUrl(specifier)))
    .filter((path) => path.startsWith('src/'));
  const npm = graph.modules.map((mod) => mod.specifier).filter((specifier) => specifier.startsWith('npm:'));

  assertEquals(npm, [], 'an npm package is reachable from @ein/client');
  assertEquals(core.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path))), [], 'the contract reaches core internals');
  assertEquals(core.length <= MAX_CORE_FILES, true, `@ein/client reaches ${core.length} files under src/ (limit ${MAX_CORE_FILES}):\n  ${core.join('\n  ')}`);
});
