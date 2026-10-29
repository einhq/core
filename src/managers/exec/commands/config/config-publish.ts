import { ETC_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { bashrcSourceLines, environmentPath, isSecretKey, quoteRcValue, withLinesLast } from '../../../../lib/config/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { readLayer, writeLayer } from './store.ts';

/** Settings: everything with the CFG_ prefix, except a secret, which no shell may be given. */
const isSettingKey = (key: string): boolean => key.startsWith('CFG_') && !isSecretKey(key);

/**
 * Copy the settings this process was started with into `/etc/environment`, which
 * `/etc/bashrc` sources.
 *
 * Shells take their environment from `/etc/bashrc`, not from the Deno process,
 * and an external tool takes it from the shell that spawned it. Without this, a
 * `CFG_*` value the container was launched with would reach the boot shell and
 * the services it started, but not a service restarted later from the settings
 * page.
 *
 * Run once at boot. The file is rewritten whole, so it holds exactly this boot's
 * settings: one the deployment stops passing is gone. A secret (`CFG_*_KEY`) is
 * never written: the file is for every shell to read. It is only written when it
 * differs. This also moves the `source` lines to the end of `/etc/bashrc`, the
 * environment's first, which is what makes an operator's setting win over what
 * the container was launched with: sourcing is last-wins.
 */
export const configPublish = async (cmd: Command): CmdReturn => {
  const etcPath = cmd.env.ETC_PATH || ETC_PATH;
  const envPath = environmentPath(etcPath);
  const rcPath = join(etcPath, 'bashrc');

  try {
    // The tty's launch environment, not the shell's: that has sourced the settings files too.
    const launched = cmd.launchEnv;
    const published = Object.keys(launched).filter((key) => isSettingKey(key) && launched[key]).sort();
    // The shebang has it highlighted as bash, as /etc/bashrc is.
    const text = ['#!bash\n', ...published.map((key) => `export ${key}=${quoteRcValue(launched[key])}\n`)].join('');

    // Both are sourced by every shell, so everyone reads them.
    const props = { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o644 };
    if (text !== await readLayer(cmd, envPath)) await writeLayer(cmd, envPath, text, props);

    const rc = await readLayer(cmd, rcPath);
    const next = withLinesLast(rc, bashrcSourceLines(etcPath));
    if (next !== rc) await writeLayer(cmd, rcPath, next, props);

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, published });
    } else if (published.length > 0) {
      await cmd.write(`Published to ${envPath}: ${published.join(', ')}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`config publish: ${message}\n`);
    return 1;
  }
};

configPublish.spec = {
  name: 'config-publish',
  effect: 'write' as const,
  description: "Copy settings from this process's environment into /etc/environment",
  args: [],
};
