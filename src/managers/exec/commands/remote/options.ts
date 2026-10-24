/**
 * What `ssh`, `scp` and `ssh-copy-id` share: the `-o Option=value` settings
 * they understand, the same settings from `~/.ssh/config`, and turning the
 * command's context into an `SshUser`.
 */

import { resolve } from '@std/path';
import type { SshConnectOptions, SshUser, StrictHostKeyChecking } from '../../../../lib/ssh/mod.ts';
import { readSshConfig, sshAllowed, sshDir } from '../../../../lib/ssh/mod.ts';
import type { Command } from '../../command.ts';

/** Settings from `-o`, in OpenSSH's names, case-insensitive */
export interface SshConfigOptions {
  /** The machine to connect to, when the name given is an alias */
  hostname?: string;
  port?: number;
  user?: string;
  identity?: string;
  strictHostKeyChecking?: StrictHostKeyChecking;
  batchMode?: boolean;
  connectTimeout?: number;
  keepaliveInterval?: number;
  passwordAuth?: boolean;
}

const YES = new Set(['yes', 'true', '1']);

function flag(value: string): boolean {
  return YES.has(value.toLowerCase());
}

/**
 * Apply one `-o` argument (`Key=value` or `Key value`). Throws on an option
 * that is not supported, so a typo is not silently ignored.
 */
export function applySshOption(into: SshConfigOptions, arg: string): void {
  const m = arg.match(/^\s*([A-Za-z]+)\s*(?:=|\s)\s*(.*)$/);
  if (!m) throw new Error(`bad option: ${arg}`);
  const key = m[1].toLowerCase();
  const value = m[2].trim();

  switch (key) {
    case 'hostname':
      into.hostname = value;
      return;
    case 'port':
      into.port = parsePort(value);
      return;
    case 'user':
      into.user = value;
      return;
    case 'identityfile':
      into.identity = value;
      return;
    case 'stricthostkeychecking': {
      const v = value.toLowerCase();
      if (v === 'yes' || v === 'accept-new' || v === 'ask') into.strictHostKeyChecking = v;
      else if (v === 'no' || v === 'off') into.strictHostKeyChecking = 'no';
      else throw new Error(`unsupported StrictHostKeyChecking value: ${value}`);
      return;
    }
    case 'batchmode':
      into.batchMode = flag(value);
      return;
    case 'connecttimeout':
      into.connectTimeout = Number.parseInt(value, 10) * 1000;
      return;
    case 'serveraliveinterval':
      into.keepaliveInterval = Number.parseInt(value, 10) * 1000;
      return;
    case 'passwordauthentication':
      into.passwordAuth = flag(value);
      return;
    default:
      throw new Error(`unsupported option: ${m[1]}`);
  }
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value.trim()) {
    throw new Error(`bad port '${value}'`);
  }
  return port;
}

/** The keywords `applySshOption` takes, lowercase */
const KEYWORDS = new Set([
  'hostname',
  'port',
  'user',
  'identityfile',
  'stricthostkeychecking',
  'batchmode',
  'connecttimeout',
  'serveraliveinterval',
  'passwordauthentication',
]);

/** `%%`, `%h`, `%r`, `%p`, `%u` and `%d` in a setting, and a leading `~/` */
function expandTokens(value: string, tokens: Record<string, string>): string {
  const expanded = value.replace(/%(.)/g, (all, t: string) => t === '%' ? '%' : tokens[t] ?? all);
  return expanded.startsWith('~/') ? `${tokens.d.replace(/\/+$/, '')}/${expanded.slice(2)}` : expanded;
}

/**
 * The settings for connecting to `host`: the command line's, and for whatever
 * it left unset, `~/.ssh/config`'s (or `configFile`'s; `none` reads nothing).
 * Keywords EiN does not act on are skipped. `hostname` is the machine to
 * reach and `identity` an absolute path.
 */
export async function hostSettings(
  cmd: Command,
  host: string,
  cli: SshConfigOptions,
  configFile?: string,
): Promise<SshConfigOptions> {
  const home = cmd.env.HOME;
  const localUser = cmd.env.USER;
  const path = configFile === undefined ? `${sshDir(home)}/config` : configFile === 'none' ? undefined : resolve(cmd.cwd, configFile);

  const fromFile: SshConfigOptions = {};
  if (path) {
    const found = await readSshConfig(cmd.sys.vfs, cmd.access, home, path, { host, user: cli.user, localUser });
    for (const [keyword, value] of found) {
      if (!KEYWORDS.has(keyword)) continue;
      try {
        applySshOption(fromFile, `${keyword}=${value}`);
      } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`);
      }
    }
  }

  const settings: SshConfigOptions = { ...fromFile };
  for (const [key, value] of Object.entries(cli)) {
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }

  const hostname = settings.hostname ? expandTokens(settings.hostname, { h: host, d: home }) : host;
  if (settings.identity) {
    const fromCli = cli.identity !== undefined;
    const identity = fromCli ? settings.identity : expandTokens(settings.identity, {
      h: hostname,
      r: settings.user ?? localUser,
      p: String(settings.port ?? 22),
      u: localUser,
      d: home,
    });
    settings.identity = resolve(cmd.cwd, identity);
  }
  return { ...settings, hostname };
}

/** The connecting user, asking at the terminal only when there is one */
export function sshUserFromCommand(cmd: Command): SshUser {
  return {
    vfs: cmd.sys.vfs,
    access: cmd.access,
    user: cmd.env.USER,
    home: cmd.env.HOME,
    ask: cmd.tty ? (prompt, secret) => cmd.prompt(prompt, secret ? 'secret' : 'default') : undefined,
    warn: (text) => cmd.writeError(text),
  };
}

/** The connect options for a host, with its settings (`hostSettings`) applied */
export function connectOptions(host: string, config: SshConfigOptions, signal?: AbortSignal): SshConnectOptions {
  return {
    host: config.hostname ?? host,
    port: config.port,
    user: config.user,
    identity: config.identity,
    strictHostKeyChecking: config.strictHostKeyChecking,
    batchMode: config.batchMode,
    connectTimeout: config.connectTimeout,
    keepaliveInterval: config.keepaliveInterval,
    passwordAuth: config.passwordAuth,
    signal,
  };
}

/** Refuses (with a message) anyone outside the `ssh` group; answers whether to go on */
export async function checkSshAllowed(cmd: Command, name: string): Promise<boolean> {
  if (await sshAllowed(cmd.sys.vfs, cmd.access)) return true;
  await cmd.writeError(`${name}: permission denied, you must be a member of group 'ssh'\n`);
  return false;
}
