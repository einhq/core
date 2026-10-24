import { join } from '@std/path';
import { WWW_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';

/**
 * Bundle the modules' pages again (`ui-build --all`), after modules were set up or removed, where
 * the browser shell is served (`/var/www/ui`, linked at boot when the shell is built); a test
 * instance serves none. A failed build is reported and does not fail the setup: the modules are
 * set up either way.
 */
export const rebuildModulePages = async (cmd: Command): Promise<void> => {
  if (!await cmd.sys.vfs.exists(cmd.access, join(cmd.env.WWW_PATH || WWW_PATH, 'ui'))) return;
  const res = await cmd.execute('ui-build --all');
  if (res.code !== 0) {
    await cmd.writeError(`mod: ui-build failed: ${res.stderr.trim() || `exit ${res.code}`}\n`);
  } else if (!cmd.json && res.stdout.trim()) {
    await cmd.write(res.stdout.trimEnd().split('\n').map((line) => `  ${line}\n`).join(''));
  }
};
