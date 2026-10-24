/**
 * Every bin, core's and the modules', must carry the execute bit.
 *
 * The shell asserts `x` on a bin as the calling user before running it, and the mounts of the
 * modules and of core's files take its mode from the on-disk stat — which rsync and the image's COPY carry over from the
 * checkout, and the checkout from git. A bin committed as 100644 therefore runs for admin (who
 * bypasses the mode check) and fails for everyone else with "Access denied for operation 'x'".
 */

import { assertEquals } from '@std/assert';
import { walk } from '@std/fs/walk';
import { join, relative } from '@std/path';
import { LIB_SOURCE_DIR, REPO_ROOT, repoModules } from '../repo.ts';

Deno.test('every bin is executable', async () => {
  const notExecutable: string[] = [];
  for (const dir of [join(LIB_SOURCE_DIR, 'core'), ...repoModules().map((module) => module.dir)]) {
    for await (const entry of walk(dir, { includeDirs: false, match: [/\/bin\/[^/]+$/] })) {
      const { mode } = await Deno.stat(entry.path);
      if (mode !== null && (mode & 0o111) === 0) notExecutable.push(relative(REPO_ROOT, entry.path));
    }
  }
  assertEquals(notExecutable, [], `bins without the execute bit (fix with chmod +x, then commit):\n  ${notExecutable.join('\n  ')}`);
});
