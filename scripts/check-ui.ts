/**
 * Type-check every UI source file.
 *
 * esbuild strips types, and a module's pages are reached only through its `mod.json`, so no
 * checked entry reaches every page. Discovering the files here keeps a newly added page or
 * otherwise-unreferenced component inside the normal `deno task check` gate.
 *
 * That means **two** trees, not one. The shared components live in the shell, but every route a
 * user actually opens — albums, people, devices, locations, tracks — is a page under
 * `modules/<name>/ui/`, and those were once outside this walk: a page could import a component
 * that did not exist, pass `deno task check`, and fail at runtime with `X is not defined` because
 * esbuild left the unresolved identifier bare in the bundle. That is the exact failure this script
 * exists to prevent, so it has to cover the pages too.
 *
 * A module's aliases resolve through its `deno.jsonc`, the workspace member generated from its
 * `mod.json` — core's map does not carry them. `--config` names the workspace *root*,
 * which is what makes the member configs visible regardless of the cwd this is run from.
 */

import { walk } from '@std/fs/walk';
import { fromFileUrl, join } from '@std/path';
import { repoModules, UI_SOURCE_DIR } from '../src/modules/repo.ts';

const repoRoot = fromFileUrl(new URL('..', import.meta.url));
const sources: string[] = [];

const collect = async (root: string) => {
  for await (const entry of walk(root, { includeDirs: false, exts: ['.ts', '.tsx'] })) {
    sources.push(entry.path);
  }
};

await collect(join(UI_SOURCE_DIR, 'src', 'client'));

// Each module's pages: the files its `mod.json` `ui.routes` names are under its `ui/`.
for (const { dir } of repoModules()) {
  const uiRoot = join(dir, 'ui');
  try {
    if (!(await Deno.stat(uiRoot)).isDirectory) continue;
  } catch {
    continue; // module ships no UI
  }

  await collect(uiRoot);
}

sources.sort();

const check = new Deno.Command(Deno.execPath(), {
  args: ['check', '--config', join(repoRoot, 'deno.jsonc'), ...sources],
  stdout: 'inherit',
  stderr: 'inherit',
});
const { code } = await check.output();
// Only on success: a closing "checked" line after a failure reads as a pass under `| tail -1`.
console.log(code === 0 ? `${sources.length} UI source files checked` : `UI type-check failed (${sources.length} files)`);
Deno.exit(code);
