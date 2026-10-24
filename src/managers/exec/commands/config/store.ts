import { toText } from '@std/streams/to-text';
import { basename, dirname } from '@std/path';
import { ADMIN_GID, ADMIN_UID } from '../../../../lib/access/mod.ts';
import {
  type ConfigEntry,
  type ConfigOption,
  environmentPath,
  listConfigOptions,
  parseRc,
  readModuleSettings,
  readSecret,
  secretsPath,
  systemConfigPath,
  userConfigPath,
} from '../../../../lib/config/mod.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';

/** A settings file's owner and mode, for `writeLayer` to create it with. */
type FileProps = { uid: number; gid: number; mode: number };

/** The file `config set` writes an option to, for the calling session: a secret's own, or its scope's. */
const optionPath = (cmd: Command, option: ConfigOption): string =>
  option.type === 'secret' ? secretsPath(cmd.env.ETC_PATH) : option.scope === 'system' ? systemConfigPath(cmd.env.ETC_PATH) : userConfigPath(cmd.env.HOME || '/');

/**
 * Who owns a settings file `config set` creates, and its mode.
 *
 * The user layer is `0600`: it is sourced by every shell that runs as its owner, so anything
 * writable by others would be a way to put an `export` into someone else's environment. The
 * secrets are the administrator's alone, whoever with administrator rights wrote them; the system
 * layer is read by every shell, so everyone may read it.
 */
const optionFileProps = (cmd: Command, option: ConfigOption): FileProps =>
  option.type === 'secret' ? { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o600 } : { uid: cmd.access.uid, gid: cmd.access.gid, mode: option.scope === 'user' ? 0o600 : 0o644 };

/**
 * A layer's contents, or the empty string when it has never been written.
 *
 * A missing file is not an error: an install that has changed nothing has no
 * `/etc/config` worth creating, and every option still resolves to its default.
 */
export const readLayer = async (cmd: Command, path: string): Promise<string> => {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
};

/** Write a layer, creating the node with `props` the first time. */
export const writeLayer = async (cmd: Command, path: string, text: string, props: FileProps): Promise<void> => {
  const encoded = new TextEncoder().encode(text);

  if (!await cmd.sys.vfs.exists(cmd.access, path)) {
    const name = basename(path);
    const attrs: FileAttrs = { name, mimetype: 'text/plain', size: encoded.length };
    await cmd.sys.vfs.create<FileAttrs>(cmd.access, NODE_TYPE_FILE, dirname(path), name, {
      props: {
        ...props,
        // Content the operator edits and `pg_dump` should carry, not a
        // regenerable rendition.
        tier: 'db',
      },
      attrs,
    });
  }

  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
};

/**
 * Rewrite the file `option` lives in with `edit`, creating it the first time.
 *
 * `/etc/keys` is given back its owner and mode when they differ: one made by hand takes its mode
 * from `/etc`, which would let everyone read the keys.
 */
export const editOptionFile = async (cmd: Command, option: ConfigOption, edit: (text: string) => string): Promise<void> => {
  const path = optionPath(cmd, option);
  const props = optionFileProps(cmd, option);
  if (option.type === 'secret') {
    const existing = await cmd.sys.vfs.get(cmd.access, path).catch(() => undefined);
    if (existing && (existing.props.mode !== props.mode || existing.props.uid !== props.uid || existing.props.gid !== props.gid)) {
      await cmd.sys.vfs.update(cmd.access, path, { props });
    }
  }
  await writeLayer(cmd, path, edit(await readLayer(cmd, path)), props);
};

/**
 * Every known option with the value that is actually in force, and which layer
 * supplied it.
 *
 * Five layers, narrowest first: the user's file, the system file, the modules'
 * files (`/etc/config.d`), the inherited environment, then the compiled default.
 * The first two are what `config set` writes; the fourth is the container's own
 * environment, which `config publish` copies into `/etc/environment`, sourced
 * ahead of the settings files so those win over it.
 *
 * Without the inherited layer, clearing a setting on a host whose container sets
 * it would report the compiled default, which the running system disagrees with.
 *
 * It is read from `/etc/environment`, where `config publish` writes it, rather
 * than from `cmd.env`. A shell's environment is a snapshot taken when it opened,
 * so a shell that started after a `config set` carries that setting's value too
 * — and clearing the setting would then report the value just removed as though
 * the deployment had supplied it.
 *
 * A secret has two layers of its own, `/etc/keys` and the deployment's, and is
 * reported to anyone as set or not, with its value left empty: whether a key is
 * set is no secret, the key is.
 */
export const resolveEntries = async (cmd: Command): Promise<ConfigEntry[]> => {
  const system = parseRc(await readLayer(cmd, systemConfigPath(cmd.env.ETC_PATH)));
  const user = parseRc(await readLayer(cmd, userConfigPath(cmd.env.HOME || '/')));
  const inherited = parseRc(await readLayer(cmd, environmentPath(cmd.env.ETC_PATH)));
  const modules = await readModuleSettings(cmd.sys.vfs, cmd.access, cmd.env.ETC_PATH);
  const options = listConfigOptions();
  const secrets = new Map(
    await Promise.all(
      options.filter((option) => option.type === 'secret').map(async (option) => [option.key, await readSecret(cmd.sys.vfs, option.key, cmd.env.ETC_PATH)] as const),
    ),
  );

  return options.map((option): ConfigEntry => {
    if (option.type === 'secret') return { ...option, value: '', source: secrets.get(option.key)?.source ?? 'default' };

    // A key is only read from the layer it belongs to: a stray system-scope
    // line in a user file is not in force.
    const set = (option.scope === 'user' ? user : system).get(option.key);
    if (set !== undefined) return { ...option, value: set, source: option.scope };

    // A user setting is the user's own; a module speaks only for the system.
    const chosen = option.scope === 'system' ? modules.get(option.key) : undefined;
    if (chosen !== undefined) return { ...option, value: chosen.value, source: 'module', sourceModule: chosen.module };

    const deployed = inherited.get(option.key);
    if (deployed !== undefined && deployed !== '') return { ...option, value: deployed, source: 'environment' };

    return { ...option, value: option.default, source: 'default' };
  });
};

/** An entry's value as text output shows it: a secret that is set reads `(set)`, never its value. */
export const shownValue = (entry: ConfigEntry): string => entry.type === 'secret' ? (entry.source === 'default' ? '' : '(set)') : entry.value;

/**
 * Restart the services that read an option at start.
 *
 * Only services that are actually running are touched: a service someone
 * deliberately stopped must not be brought back to life by a settings change.
 *
 * The restarted shell picks the new value up from `/etc/config` on its own: a
 * shell sources `/etc/bashrc` after the env it is passed, so the caller's stale
 * copy of the value loses to the file. Returns the names restarted and,
 * separately, the ones that failed, so the UI can say which.
 */
export const restartConsumers = async (
  cmd: Command,
  services: string[] | undefined,
): Promise<{ restarted: string[]; failed: { name: string; error: string }[] }> => {
  const restarted: string[] = [];
  const failed: { name: string; error: string }[] = [];

  const manager = cmd.sys.serviceManager;
  if (!manager || !services?.length) return { restarted, failed };

  for (const name of services) {
    if (manager.getStatus(name) !== 'running') continue;

    try {
      await manager.restart(name, cmd.env);
      restarted.push(name);
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { restarted, failed };
};
