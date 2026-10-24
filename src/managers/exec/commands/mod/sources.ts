import { getConfigOption } from '../../../../lib/config/registry.ts';
import { readSecret, readSettings } from '../../../../lib/config/read-settings.ts';
import { type ModuleSource, parseSources, parseTokens, type Tokens } from '../../../../modules/forge.ts';
import type { Command } from '../../command.ts';

/** How long a forge has to answer a question about its repositories. */
export const FORGE_TIMEOUT_MS = 30_000;

/** How long a module's archive may take to arrive. */
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/** A signal that ends the request when the command is interrupted or after `ms`. */
export const within = (cmd: Command, ms: number): AbortSignal => AbortSignal.any([cmd.interruptSignal, AbortSignal.timeout(ms)]);

/**
 * The module sources the settings name now (`CFG_MODULE_SOURCES`, its default when unset), what is
 * wrong with any entry, and the tokens for their hosts (`CFG_MODULE_SOURCES_KEY`).
 */
export const moduleSources = async (cmd: Command): Promise<{ sources: ModuleSource[]; problems: string[]; tokens: Tokens }> => {
  const settings = await readSettings(cmd, cmd.access, { user: false });
  const value = settings.CFG_MODULE_SOURCES ?? getConfigOption('CFG_MODULE_SOURCES')?.default ?? '';
  const secret = await readSecret(cmd.sys.vfs, 'CFG_MODULE_SOURCES_KEY', cmd.env.ETC_PATH);
  return { ...parseSources(value), tokens: parseTokens(secret?.value ?? '') };
};
