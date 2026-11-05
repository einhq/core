import { createLogger } from '../../managers/logger/mod.ts';
import { CORE_OPTIONS } from './options.ts';
import { isSecretKey } from './read-settings.ts';
import type { ConfigOption } from './types.ts';

const logger = createLogger('config-registry');

/**
 * The live option table: core's own, plus whatever the installed modules
 * declared.
 *
 * Modules register at `mod setup` and unregister at `mod remove`, exactly as
 * they do for external commands — a module that owns a knob should own its
 * description too, and core has no business knowing what a captioning VRAM floor
 * is. Core's entries carry no owner and can neither be shadowed nor removed.
 */
const options = new Map<string, ConfigOption>(CORE_OPTIONS.map((option) => [option.key, option]));

/**
 * Settings a module declared while another module owned the key, by key: the first to wait takes
 * the key when its owner lets go. An update that moves a setting from one module to another sets
 * up the new owner first when it is a dependency of the old one, so without this the setting
 * would have no owner until the next start.
 */
const waiting = new Map<string, ConfigOption>();

/** Drop the owner's entry for a key, and hand the key to the module waiting for it. */
const release = (key: string) => {
  options.delete(key);
  const next = waiting.get(key);
  if (!next) return;
  waiting.delete(key);
  options.set(key, next);
  logger.info('module config option taken over', { owner: next.owner, key });
};

/** Validate one declaration well enough that a bad `mod.json` is refused, not half-installed. */
export const validateConfigOption = (option: ConfigOption): string | undefined => {
  if (!option.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(option.key)) {
    return `invalid key '${option.key}'`;
  }
  if (option.scope !== 'system' && option.scope !== 'user') {
    return `option '${option.key}': scope must be 'system' or 'user'`;
  }
  if (option.type === 'select' && (!option.choices || option.choices.length === 0)) {
    return `option '${option.key}': type 'select' needs choices`;
  }
  if (typeof option.default !== 'string') {
    return `option '${option.key}': default must be a string`;
  }
  // The user layer is sourced after the system one, so a user-scope key that
  // did not announce itself as one could shadow a system setting for any shell
  // whose HOME it lands in — including a service shell running as admin.
  if (option.scope === 'user' && !option.key.startsWith('CFG_USER_') && option.key !== 'HISTSIZE') {
    return `option '${option.key}': user-scope keys must be named CFG_USER_*`;
  }
  if (option.scope === 'system' && option.key.startsWith('CFG_USER_')) {
    return `option '${option.key}': CFG_USER_* is reserved for user-scope options`;
  }
  // Boot keeps a secret out of the shells by its name alone, before any module is set up, so the
  // name and the type must agree both ways.
  if ((option.type === 'secret') !== isSecretKey(option.key)) {
    return `option '${option.key}': a secret is named CFG_*_KEY, and only a secret is`;
  }
  if (option.type === 'secret' && (option.scope !== 'system' || option.default !== '')) {
    return `option '${option.key}': a secret is a system setting with no default`;
  }
  return undefined;
};

/**
 * Register a module's options.
 *
 * Returns the keys registered. A module set up again, after an update, replaces its own options,
 * so a changed default or description holds from then on, and an option it no longer declares is
 * dropped. A key core or another module already
 * owns is declined with a warning rather than an error: the module is otherwise fine, and refusing
 * the whole setup over a name collision would take a working module offline. A declined option
 * waits, and is registered when the module owning the key drops it.
 */
export const registerConfigOptions = (owner: string, declared: ConfigOption[]): string[] => {
  const added: string[] = [];
  const keys = new Set(declared.map((option) => option.key));
  for (const [key, option] of waiting) {
    if (option.owner === owner && !keys.has(key)) waiting.delete(key);
  }
  for (const [key, option] of options) {
    if (option.owner === owner && !keys.has(key)) release(key);
  }

  for (const option of declared) {
    const invalid = validateConfigOption(option);
    if (invalid) {
      logger.warn('module config option ignored', { owner, reason: invalid });
      continue;
    }

    const existing = options.get(option.key);
    if (existing && existing.owner !== owner) {
      logger.warn('module config option ignored, key already registered', {
        owner,
        key: option.key,
        registeredBy: existing.owner ?? 'core',
      });
      const first = waiting.get(option.key);
      if (!first || first.owner === owner) waiting.set(option.key, { ...option, owner });
      continue;
    }

    waiting.delete(option.key);
    options.set(option.key, { ...option, owner });
    added.push(option.key);
  }

  if (added.length > 0) logger.info('registered module config options', { owner, added });
  return added;
};

/**
 * Drop the options a module registered, each to the module waiting for its key, and the ones it
 * waits for. Core's carry no owner and are never removed.
 */
export const unregisterConfigOptions = (owner: string): string[] => {
  const removed: string[] = [];

  for (const [key, option] of waiting) {
    if (option.owner === owner) waiting.delete(key);
  }
  for (const [key, option] of options) {
    if (option.owner !== owner) continue;
    release(key);
    removed.push(key);
  }

  if (removed.length > 0) logger.info('unregistered module config options', { owner, removed });
  return removed;
};

export const getConfigOption = (key: string): ConfigOption | undefined => options.get(key);

/** Every known option, ordered by group then label, which is also the UI's order. */
export const listConfigOptions = (): ConfigOption[] => [...options.values()].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
