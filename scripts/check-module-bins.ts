/**
 * Type-check every `#!ts` module bin.
 *
 * These are invisible to `deno check` and `deno task test:check`: the shebang makes them invalid
 * TypeScript, and nothing imports them — the shell loads them at runtime. So a plain
 * `targets is not defined` in `generate-derivatives` once shipped past check/test:check/lint and
 * only surfaced as `code 255` in the container tier, and `device-match` called a `cmd.flags` that
 * has never existed on `Command`, throwing a TypeError on its first line for as long as it was
 * there.
 *
 * A bin resolves against its own module's manifest, the same map the loader uses at runtime
 * (`src/managers/shell/ts-command-loader.ts`): the stripped copy is written beside the original,
 * inside `modules/<name>/`, which is a Deno workspace member whose `deno.jsonc` is generated from
 * `mod.json` by `deno task sync:modules`. So a specifier the module has not declared fails here
 * rather than resolving off an alias core's map happened to carry.
 *
 * Note this is a member map, not a replacement for core's. An earlier attempt generated a
 * standalone import map per module and it had to be abandoned: `@ein/client` drags core's whole
 * graph in behind it, and re-resolving pg/ssh2 under a synthetic map collapsed their npm types
 * into a cascade of implicit-any errors from inside `src/` that said nothing about the module. A
 * member only adds, so those specifiers still resolve through the root map exactly as they did.
 *
 * `--config` is still core's `deno.jsonc` — that is the *workspace root*, which is how the member
 * configs are found at all, and passing it means the script does not depend on the cwd it is run
 * from.
 *
 * Also the execute bit: the mounted `/usr/modules/<name>/bin/<cmd>` node takes its mode from
 * the file, and a bin committed as 100644 is "Access denied for operation 'x'" for every
 * non-admin user — which is how the chat broke in production the first time a clean worktree was
 * synced there (2026-09-21; 23 bins had shipped that way).
 *
 * Usage: deno run -A scripts/check-module-bins.ts [modules-dir]
 */

import { basename, dirname, fromFileUrl, join, resolve } from '@std/path';
import { walk } from '@std/fs/walk';
import { repoModules } from '../src/modules/repo.ts';

const SHEBANG = '#!ts';

const repoRoot = fromFileUrl(new URL('..', import.meta.url));
// Every module's bins; or those under a directory given.
const moduleRoots = Deno.args[0] ? [resolve(Deno.args[0])] : repoModules().map((module) => module.dir);

async function* filesUnder(roots: string[]) {
  for (const root of roots) yield* walk(root, { includeDirs: false });
}

const staged: string[] = [];
const notExecutable: string[] = [];
let checked = 0;
let exitCode = 0;

try {
  for await (const entry of filesUnder(moduleRoots)) {
    // Only bin/ holds commands; skip anything with a real extension (lib/, types/, test/).
    if (!entry.path.includes('/bin/')) continue;
    if (/\.[a-z]+$/.test(entry.name)) continue;

    let source: string;
    try {
      source = await Deno.readTextFile(entry.path);
    } catch {
      continue;
    }
    if (!source.startsWith(`${SHEBANG}\n`) && !source.startsWith(`${SHEBANG}\r\n`)) continue;
    const mode = (await Deno.stat(entry.path)).mode ?? 0o755;
    if ((mode & 0o111) !== 0o111) notExecutable.push(entry.path);

    const stagedPath = join(dirname(entry.path), `.check-${basename(entry.path)}.ts`);
    await Deno.writeTextFile(stagedPath, source.slice(source.indexOf('\n') + 1));
    staged.push(stagedPath);
    checked++;
  }

  if (staged.length === 0) {
    console.log('no #!ts bins found');
  } else {
    const check = new Deno.Command(Deno.execPath(), {
      args: ['check', '--config', join(repoRoot, 'deno.jsonc'), ...staged],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    exitCode = (await check.output()).code;
    console.log(`${checked} #!ts bins checked`);
  }
  if (notExecutable.length > 0) {
    console.error(`${notExecutable.length} #!ts bins are not executable (chmod +x, then git add):`);
    for (const path of notExecutable) console.error(`  ${path}`);
    exitCode ||= 1;
  }
} finally {
  for (const path of staged) {
    await Deno.remove(path).catch(() => {});
  }
}

// Deliberately outside the try: `Deno.exit` terminates immediately and does NOT run `finally`,
// so exiting in there leaves all 76 staged copies on disk — which is exactly what happened the
// first time this ran and failed.
Deno.exit(exitCode);
