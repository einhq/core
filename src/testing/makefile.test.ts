import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';

const REPO_DIR = fromFileUrl(new URL('../../', import.meta.url));

const decoder = new TextDecoder();

Deno.test("the deployment's settings file and modules reach the container", async () => {
  const output = await new Deno.Command('make', {
    args: ['-n', 'container-run', 'ENV_FILE=/deploy/settings.env', 'MODULES_PATH=/deploy/modules'],
    cwd: REPO_DIR,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const command = decoder.decode(output.stdout);
  assertEquals(output.success, true, decoder.decode(output.stderr));
  assert(command.includes('--env-file /deploy/settings.env'), `settings file missing from container command:\n${command}`);
  assert(command.includes('-v /deploy/modules:/modules-dev:ro'), `modules missing from container command:\n${command}`);
});

Deno.test('without a settings file the container gets none', async () => {
  const output = await new Deno.Command('make', { args: ['-n', 'container-run'], cwd: REPO_DIR, stdout: 'piped', stderr: 'piped' }).output();
  assertEquals(decoder.decode(output.stdout).includes('--env-file'), false);
});
