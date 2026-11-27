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
 *
 * A module's Web Workers (`ui.workers`) are a program of their own, checked with the `webworker`
 * library (`scripts/ui-workers.ts`); the files only they reach are left out of the pages' program,
 * and a file pages and workers share is in both.
 */

import { walk } from '@std/fs/walk';
import { fromFileUrl, join, resolve } from '@std/path';
import { repoModules, UI_SOURCE_DIR } from '../src/modules/repo.ts';
import { checkWorkers, localGraph, workerScripts } from './ui-workers.ts';

const repoRoot = fromFileUrl(new URL('..', import.meta.url));
const config = join(repoRoot, 'deno.jsonc');
let sources: string[] = [];
const workers: string[] = [];

const collect = async (root: string) => {
  for await (const entry of walk(root, { includeDirs: false, exts: ['.ts', '.tsx'] })) {
    sources.push(entry.path);
  }
};

// The shell's components and every module's pages; or one module's pages.
if (!Deno.args[0]) await collect(join(UI_SOURCE_DIR, 'src', 'client'));
const moduleDirs = Deno.args[0] ? [resolve(Deno.args[0])] : repoModules().map((module) => module.dir);

// Each module's pages: the files its `mod.json` `ui.routes` names are under its `ui/`.
for (const dir of moduleDirs) {
  workers.push(...await workerScripts(dir));
  const uiRoot = join(dir, 'ui');
  try {
    if (!(await Deno.stat(uiRoot)).isDirectory) continue;
  } catch {
    continue; // module ships no UI
  }

  await collect(uiRoot);
}

const workerFiles = workers.length ? await localGraph(config, workers) : new Set<string>();
sources = sources.filter((file) => !workerFiles.has(file)).sort();
if (sources.length === 0 && workers.length === 0) {
  console.log('no UI source files found');
  Deno.exit(0);
}

let code = 0;
if (sources.length > 0) {
  code = (await new Deno.Command(Deno.execPath(), { args: ['check', '--config', config, ...sources], stdout: 'inherit', stderr: 'inherit' }).output()).code;
  // Only on success: a closing "checked" line after a failure reads as a pass under `| tail -1`.
  console.log(code === 0 ? `${sources.length} UI source files checked` : `UI type-check failed (${sources.length} files)`);
}
if (workers.length > 0) {
  const workerCode = await checkWorkers(repoRoot, workers.sort());
  console.log(workerCode === 0 ? `${workers.length} UI workers checked` : `UI worker type-check failed (${workers.length} workers)`);
  code ||= workerCode;
}
Deno.exit(code);
