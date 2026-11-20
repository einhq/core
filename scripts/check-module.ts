/**
 * Type-check one module: what its own check runs on a push (its `.github/workflows/test.yml`).
 *
 * Three programs, as core's `deno task check` has: the module's server-side files, its pages
 * (scripts/check-ui.ts), and its `#!ts` bins (scripts/check-module-bins.ts). The pages are checked
 * apart because a browser file checked beside server code takes Node's `setTimeout`, whose
 * `Timeout` is not the browser's `number`.
 *
 * The modules it depends on must be beside it in `modules/`, as scripts/module-deps.ts puts them:
 * its files import theirs.
 *
 * Usage: deno run -A scripts/check-module.ts <module-dir>
 */

import { walk } from '@std/fs/walk';
import { fromFileUrl, join, resolve } from '@std/path';

const repoRoot = fromFileUrl(new URL('..', import.meta.url));
if (!Deno.args[0]) {
  console.error('usage: check-module.ts <module-dir>');
  Deno.exit(2);
}
const moduleDir = resolve(Deno.args[0]);

const sources: string[] = [];
for await (
  const entry of walk(moduleDir, { includeDirs: false, exts: ['.ts', '.tsx'], skip: [/\/\.git\//, /\/node_modules\//] })
) {
  if (!entry.path.startsWith(join(moduleDir, 'ui') + '/')) sources.push(entry.path);
}
sources.sort();

const run = async (args: string[]) => (await new Deno.Command(Deno.execPath(), { args, stdout: 'inherit', stderr: 'inherit' }).output()).code;

// Each runs though the one before failed, so one push shows all three's errors.
const codes: number[] = [];
if (sources.length > 0) {
  const code = await run(['check', '--config', join(repoRoot, 'deno.jsonc'), ...sources]);
  console.log(code === 0 ? `${sources.length} source files checked` : `type-check failed (${sources.length} files)`);
  codes.push(code);
}
codes.push(await run(['run', '-A', join(repoRoot, 'scripts', 'check-ui.ts'), moduleDir]));
codes.push(await run(['run', '-A', join(repoRoot, 'scripts', 'check-module-bins.ts'), moduleDir]));
Deno.exit(codes.find((code) => code !== 0) ?? 0);
