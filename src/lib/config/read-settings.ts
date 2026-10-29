import { toText } from '@std/streams/to-text';
import type { Access } from '../access/types.ts';
import { ADMIN_ACCESS, USERS_GROUPNAME } from '../access/constants.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { ETC_PATH, MOD_PATH } from '../paths.ts';
import { parseRc } from './rc-file.ts';
import { environmentPath, moduleConfigDir, secretsPath, systemConfigPath, userConfigPath } from './paths.ts';

/** Enough of a command to read against — core's `Command` and a module's both satisfy it. */
export type SettingsContext = {
  readonly sys: { readonly vfs: NodeVFS };
  readonly env: Record<string, string>;
};

/**
 * Settings as they are *now*, rather than as they were when this shell opened.
 *
 * A shell sources `/etc/bashrc` when it opens and again before the next
 * command it is given after a settings file changed, but a script that keeps
 * running — a service's loop — keeps the environment it started with, and so
 * does every command it runs.
 *
 * So anything that reads a setting as *policy*, at the moment it is applied,
 * reads it through here: the files first, the environment behind them. Two small
 * reads, on operations that are already doing several.
 *
 * The precedence is the one sourcing produces — the user's file over the system
 * file over the modules' files over whatever the shell inherited.
 */
export const readSettings = async (ctx: SettingsContext, access: Access, opts?: { user?: boolean }): Promise<Record<string, string>> => {
  const layers = [systemConfigPath(ctx.env.ETC_PATH)];
  if (opts?.user !== false && ctx.env.HOME) layers.push(userConfigPath(ctx.env.HOME));

  const settings: Record<string, string> = { ...ctx.env };
  for (const [key, { value }] of await readModuleSettings(ctx.sys.vfs, access, ctx.env.ETC_PATH)) settings[key] = value;
  for (const path of layers) Object.assign(settings, Object.fromEntries(await readLayer(ctx.sys.vfs, access, path)));
  return settings;
};

/**
 * The system's settings as its files in `/etc` hold them: the deployment's (`/etc/environment`),
 * the modules' and the administrator's, in the order `/etc/bashrc` sources them, read as the
 * administrator.
 *
 * Nothing of the caller's environment enters, so a command may decide what its caller is allowed
 * by it: any shell can set a variable in front of a command line, and `readSettings` starts from
 * exactly that.
 *
 * Read once per VFS and kept until something under `/etc` or the modules' tree changes, which is
 * where every file read here and every module's `etc/config` live: the guest asks this on each
 * request it makes.
 */
const readSystemSettings = async (vfs: NodeVFS): Promise<Readonly<Record<string, string>>> => {
  let cache = systemSettings.get(vfs);
  if (!cache) {
    const entry: SettingsCache = { watched: watchSettings(vfs, () => entry.settings = undefined) };
    systemSettings.set(vfs, cache = entry);
  }
  if (!await cache.watched) return readSystemSettingsFiles(vfs);
  return cache.settings ??= readSystemSettingsFiles(vfs);
};

type SettingsCache = {
  /** Resolves to whether changes are seen; only then is `settings` kept. */
  readonly watched: Promise<boolean>;
  settings?: Promise<Record<string, string>>;
};

const systemSettings = new WeakMap<NodeVFS, SettingsCache>();

/** Call `changed` after every write under `/etc` or the modules' tree, or tell that it cannot. */
const watchSettings = async (vfs: NodeVFS, changed: () => void): Promise<boolean> => {
  if (!vfs.subscribe) return false;
  for (const pathPrefix of [ETC_PATH, MOD_PATH]) await vfs.subscribe(() => ADMIN_ACCESS, changed, { pathPrefix });
  return true;
};

const readSystemSettingsFiles = async (vfs: NodeVFS): Promise<Record<string, string>> => {
  const settings = Object.fromEntries(await readLayer(vfs, ADMIN_ACCESS, environmentPath()));
  for (const [key, { value }] of await readModuleSettings(vfs, ADMIN_ACCESS)) settings[key] = value;
  return Object.assign(settings, Object.fromEntries(await readLayer(vfs, ADMIN_ACCESS, systemConfigPath())));
};

/**
 * Whether the administrator opens the archive to the guest, whoever reaches the server without
 * signing in: `CFG_GUEST_BROWSING`, set to `true` for a public demo and off unless it is.
 */
export const guestMayBrowse = async (vfs: NodeVFS): Promise<boolean> => (await readSystemSettings(vfs)).CFG_GUEST_BROWSING === 'true';

/**
 * The groups a new account joins besides its own when `user-create` is given none, as a comma
 * list: `CFG_DEFAULT_USER_GROUPS` as the system's files hold it now, `users` when they leave it
 * unset, and empty, for none, when it is set empty. A shell's environment holds the value from when
 * it opened, so it does not enter.
 */
export const defaultUserGroups = async (vfs: NodeVFS): Promise<string> => (await readSystemSettings(vfs)).CFG_DEFAULT_USER_GROUPS ?? USERS_GROUPNAME;

/**
 * Whether a setting is a secret: a key EiN sends to a service it calls, which no shell may see.
 *
 * The name alone decides it, `CFG_*_KEY`, so boot can leave one out of the shells' environment
 * before any module has declared it. Its value is never exported: the deployment's stays in this
 * process's own environment, and one the administrator sets is in `/etc/keys`, which only the
 * administrator reads and `/etc/bashrc` does not source. The code that calls the service reads it
 * when it makes the request (`serviceKey`).
 */
export const isSecretKey = (key: string): boolean => /^CFG_[A-Z0-9_]+_KEY$/.test(key);

/**
 * A secret's value and where it comes from — the administrator's `/etc/keys`, over the
 * deployment's environment — or nothing when neither set it.
 */
export const readSecret = async (vfs: NodeVFS, key: string, etcPath?: string): Promise<{ value: string; source: 'system' | 'environment' } | undefined> => {
  if (!isSecretKey(key)) return undefined;
  const set = (await readLayer(vfs, ADMIN_ACCESS, secretsPath(etcPath))).get(key);
  if (set) return { value: set, source: 'system' };
  const deployed = Deno.env.get(key);
  if (deployed) return { value: deployed, source: 'environment' };
  return undefined;
};

/**
 * The secret `key` for a request to the service whose address is the setting `urlKey`, read as
 * the administrator.
 *
 * Only the system's own address gets it. Any shell can put `<urlKey>=…` in front of a command,
 * so a request going anywhere but the address the system's files hold goes without the key;
 * otherwise whoever answers there would receive it.
 */
export const serviceKey = async (ctx: SettingsContext, key: string, urlKey: string): Promise<string | undefined> => {
  const secret = await readSecret(ctx.sys.vfs, key);
  if (!secret) return undefined;
  const system = await readSystemSettings(ctx.sys.vfs);
  return (ctx.env[urlKey] ?? '') === (system[urlKey] ?? '') ? secret.value : undefined;
};

/** A settings file's keys and values. */
const readLayer = async (vfs: NodeVFS, access: Access, path: string): Promise<Map<string, string>> => {
  try {
    const handle = await vfs.open(access, path, { mode: 'r' });
    try {
      return parseRc(await toText(handle.readable));
    } finally {
      await handle.close();
    }
  } catch {
    // A layer that has never been written, or that this session may not read,
    // simply contributes nothing.
    return new Map();
  }
};

/**
 * The modules' layer: every `/etc/config.d/<module>` file, in name order as `/etc/bashrc` sources
 * them, so a later module's value for a key wins over an earlier one's. Each value carries the
 * module that set it.
 */
export const readModuleSettings = async (vfs: NodeVFS, access: Access, etcPath?: string): Promise<Map<string, { value: string; module: string }>> => {
  const settings = new Map<string, { value: string; module: string }>();
  const dir = moduleConfigDir(etcPath);
  let names: string[];
  try {
    names = (await vfs.children(access, dir)).map((entry) => entry.name).sort();
  } catch {
    return settings;
  }
  for (const name of names) {
    try {
      const handle = await vfs.open(access, `${dir}/${name}`, { mode: 'r' });
      try {
        for (const [key, value] of parseRc(await toText(handle.readable))) settings.set(key, { value, module: name });
      } finally {
        await handle.close();
      }
    } catch {
      // A dangling link, left by a module whose code is gone, contributes nothing.
    }
  }
  return settings;
};
