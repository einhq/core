import { getConfigOption } from '../../../../lib/config/registry.ts';
import { readSecret, readSettings } from '../../../../lib/config/read-settings.ts';
import { type InsecureHosts, type ModuleSource, parseInsecureHosts, parseSources, parseTokens, type Tokens } from '../../../../modules/forge.ts';
import type { Command } from '../../command.ts';

/** How long a forge has to answer a question about its repositories. */
export const FORGE_TIMEOUT_MS = 30_000;

/** How long a module's archive may take to arrive. */
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/** A signal that ends the request when the command is interrupted or after `ms`. */
export const within = (cmd: Command, ms: number): AbortSignal => AbortSignal.any([cmd.interruptSignal, AbortSignal.timeout(ms)]);

/**
 * The module sources the settings name now (`CFG_MODULE_SOURCES`, its default when unset), what is
 * wrong with any entry, the hosts that may be reached over plain http (`CFG_MODULE_SOURCES_INSECURE`),
 * the tokens for their origins (`CFG_MODULE_SOURCES_KEY`), and whether a prerelease is taken like a
 * release (`CFG_MODULE_PRERELEASES`).
 */
export const moduleSources = async (
  cmd: Command,
): Promise<{ sources: ModuleSource[]; problems: string[]; insecure: InsecureHosts; tokens: Tokens; prereleases: boolean }> => {
  const settings = await readSettings(cmd, cmd.access, { user: false });
  const value = settings.CFG_MODULE_SOURCES ?? getConfigOption('CFG_MODULE_SOURCES')?.default ?? '';
  const insecure = parseInsecureHosts(settings.CFG_MODULE_SOURCES_INSECURE ?? '');
  const secret = await readSecret(cmd.sys.vfs, 'CFG_MODULE_SOURCES_KEY', cmd.env.ETC_PATH);
  const prereleases = (settings.CFG_MODULE_PRERELEASES ?? getConfigOption('CFG_MODULE_PRERELEASES')?.default) === 'true';
  return { ...parseSources(value, insecure), insecure, tokens: parseTokens(secret?.value ?? ''), prereleases };
};
