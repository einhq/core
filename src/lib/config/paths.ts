import { join } from '@std/path';
import { ETC_PATH } from '../paths.ts';

/**
 * Where the layers live.
 *
 * `$ETC_PATH/bashrc`, which every shell sources at the end of `Shell.open()`, ends by sourcing
 * them in order, so each is exported over the one before:
 *
 *   1. `$ETC_PATH/environment` — the `CFG_*` settings the container was started with, rewritten
 *      whole by `config publish` at every boot;
 *   2. `$ETC_PATH/config.d/<module>` — a module's own choice of a setting's value, its `etc/config`
 *      linked there by `mod setup` (the assistant names its search parser this way);
 *   3. `$ETC_PATH/config` — the administrator's settings;
 *   4. `$HOME/.config` — the user's.
 *
 * All are ordinary shell files in the VFS, which means they are in PostgreSQL and survive a
 * restart.
 */
const ENVIRONMENT_NAME = 'environment';
const SYSTEM_CONFIG_NAME = 'config';
const USER_CONFIG_NAME = '.config';
const MODULE_CONFIG_DIR_NAME = 'config.d';
const SECRETS_NAME = 'keys';

/** The deployment's settings, as `config publish` last wrote them. */
export const environmentPath = (etcPath?: string): string => join(etcPath || ETC_PATH, ENVIRONMENT_NAME);

export const systemConfigPath = (etcPath?: string): string => join(etcPath || ETC_PATH, SYSTEM_CONFIG_NAME);

export const userConfigPath = (home: string): string => join(home, USER_CONFIG_NAME);

/** The directory of the modules' settings files, one per module, named after it. */
export const moduleConfigDir = (etcPath?: string): string => join(etcPath || ETC_PATH, MODULE_CONFIG_DIR_NAME);

/**
 * The administrator's keys to other services: `export KEY='value'` lines like `/etc/config`, but
 * mode 0600 and sourced by nothing (see `serviceKey`).
 */
export const secretsPath = (etcPath?: string): string => join(etcPath || ETC_PATH, SECRETS_NAME);

export const bashrcSourceLines = (etcPath = ETC_PATH): string[] => [
  `[ -r ${environmentPath(etcPath)} ] && source ${environmentPath(etcPath)}`,
  `for f in ${moduleConfigDir(etcPath)}/*; do [ -r "$f" ] && source "$f"; done`,
  `[ -r ${join(etcPath, SYSTEM_CONFIG_NAME)} ] && source ${join(etcPath, SYSTEM_CONFIG_NAME)}`,
  `[ -n "$HOME" ] && [ -r "$HOME/${USER_CONFIG_NAME}" ] && source "$HOME/${USER_CONFIG_NAME}"`,
];
