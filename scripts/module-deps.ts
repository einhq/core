/**
 * Clone the modules a module depends on into `modules/`, beside it, for its own check on a push
 * (its `.github/workflows/test.yml`): its files import theirs, so it neither type-checks nor runs
 * its tests without them. Each comes at its `main`, and so do the modules it depends on in turn.
 * Only the module's own tests run; how the modules work together is not this check's to test.
 *
 * A module `<name>` is the repository `module-<name>` beside core, on the forge the check runs on:
 * `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY_OWNER`, which Forgejo's runner sets as GitHub's does.
 * `TOKEN` reads them, where the forge wants a sign-in to.
 *
 * Usage: deno run -A scripts/module-deps.ts <module-dir>
 */

import { join, resolve } from '@std/path';
import { MODULES_DIR } from '../src/modules/repo.ts';

if (!Deno.args[0]) {
  console.error('usage: module-deps.ts <module-dir>');
  Deno.exit(2);
}

const server = new URL(Deno.env.get('GITHUB_SERVER_URL') ?? 'https://github.com');
const owner = Deno.env.get('GITHUB_REPOSITORY_OWNER') ?? 'einhq';
const token = Deno.env.get('TOKEN');
if (token) {
  server.username = 'x-access-token';
  server.password = token;
}

const dependencies = async (dir: string): Promise<string[]> => {
  const manifest = JSON.parse(await Deno.readTextFile(join(dir, 'mod.json')));
  return Object.keys(manifest.dependencies ?? {});
};

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const pending = await dependencies(resolve(Deno.args[0]));
while (pending.length > 0) {
  const name = pending.shift()!;
  const dir = join(MODULES_DIR, name);
  if (await exists(dir)) continue;
  const url = new URL(`${owner}/module-${name}.git`, server).href;
  const { code } = await new Deno.Command('git', {
    args: ['clone', '--quiet', '--depth', '1', url, dir],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  if (code !== 0) {
    console.error(`could not clone module-${name}`);
    Deno.exit(code);
  }
  console.log(`cloned module-${name}`);
  pending.push(...await dependencies(dir));
}
