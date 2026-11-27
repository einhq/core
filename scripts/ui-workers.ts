/**
 * Type-check modules' Web Workers (`mod.json` `ui.workers`) apart from their pages: a worker runs
 * in a worker's global scope, which has `FileReaderSync`, `importScripts` and `postMessage` to its
 * page but no `document`, so its scripts are checked with TypeScript's `webworker` library instead
 * of `dom`. A JavaScript worker is not type-checked, as no other JavaScript is.
 *
 * `deno check` takes its libraries from the configuration alone, and a module's files resolve
 * their imports only through the workspace whose root is core's `deno.jsonc`; so the workers are
 * checked against a copy of it beside it whose one difference is the library, removed afterwards.
 */

import { parse } from '@std/jsonc';
import { fromFileUrl, join, resolve } from '@std/path';

/** The TypeScript scripts a module names in `ui.workers`, as absolute paths. */
export const workerScripts = async (moduleDir: string): Promise<string[]> => {
  let manifest: { ui?: { workers?: unknown } };
  try {
    manifest = JSON.parse(await Deno.readTextFile(join(moduleDir, 'mod.json')));
  } catch {
    return [];
  }
  const workers = manifest.ui?.workers;
  if (!workers || typeof workers !== 'object') return [];
  return Object.values(workers).filter((file): file is string => typeof file === 'string' && file.endsWith('.ts')).map((file) => resolve(moduleDir, file));
};

/** Every local file the scripts import, themselves included, through the workspace of `config`. */
export const localGraph = async (config: string, scripts: string[]): Promise<Set<string>> => {
  const files = new Set<string>();
  for (const script of scripts) {
    const { success, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ['info', '--json', '--config', config, script],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!success) throw new Error(`deno info ${script}: ${new TextDecoder().decode(stderr).trim()}`);
    const { modules } = JSON.parse(new TextDecoder().decode(stdout)) as { modules: { specifier: string }[] };
    for (const { specifier } of modules) if (specifier.startsWith('file://')) files.add(fromFileUrl(specifier));
  }
  return files;
};

/** Type-check the worker scripts with the `webworker` library; the exit code of `deno check`. */
export const checkWorkers = async (repoRoot: string, scripts: string[]): Promise<number> => {
  const root = parse(await Deno.readTextFile(join(repoRoot, 'deno.jsonc'))) as { compilerOptions?: Record<string, unknown> };
  const config = join(repoRoot, `.check-workers-${Deno.pid}.json`);
  await Deno.writeTextFile(config, JSON.stringify({ ...root, compilerOptions: { ...root.compilerOptions, lib: ['esnext', 'webworker'] } }));
  try {
    const { code } = await new Deno.Command(Deno.execPath(), { args: ['check', '--config', config, ...scripts], stdout: 'inherit', stderr: 'inherit' }).output();
    return code;
  } finally {
    await Deno.remove(config).catch(() => {});
  }
};
