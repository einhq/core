import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';

const REPO_DIR = fromFileUrl(new URL('../../', import.meta.url));

const decoder = new TextDecoder();

Deno.test("the deployment's settings file, its modules and the folder of installed ones reach the container", async () => {
  const output = await new Deno.Command('make', {
    args: ['-n', 'container-run', 'ENV_FILE=/deploy/settings.env', 'MODULES_PATH=/deploy/modules', 'MODULE_INSTALL_PATH=/deploy/modules-installed'],
    cwd: REPO_DIR,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const command = decoder.decode(output.stdout);
  assertEquals(output.success, true, decoder.decode(output.stderr));
  assert(command.includes('--env-file /deploy/settings.env'), `settings file missing from container command:\n${command}`);
  assert(command.includes('-v /deploy/modules:/modules-dev:ro'), `modules missing from container command:\n${command}`);
  // Read-write, and named to the process, so `mod install` writes to the host's folder.
  assert(command.includes('-v /deploy/modules-installed:/modules-installed '), `installed modules missing from container command:\n${command}`);
  assert(command.includes('-e MODULE_INSTALL_PATH=/modules-installed'), `install path missing from container command:\n${command}`);
});

Deno.test('without a settings file the container gets none', async () => {
  const output = await new Deno.Command('make', { args: ['-n', 'container-run'], cwd: REPO_DIR, stdout: 'piped', stderr: 'piped' }).output();
  assertEquals(decoder.decode(output.stdout).includes('--env-file'), false);
});
