/**
 * Every command on the user's PATH with its spec: the command catalogue.
 *
 * A spec comes from `<name> --help`, the one route that works for core and module commands alike.
 * A script is asked only when it declares one (`declaresSpec`): asking any other runs it.
 * Asking three hundred of them costs seconds, so the catalogue is kept: in memory for the life of
 * the process, per user (what they can reach on their PATH is theirs), and in the user's home for
 * the next process. A command is asked again only when its node changed, which is what a deploy or
 * `mod setup` does to it; the PATH is listed again at most every `RELIST_MS`.
 *
 * The documentation's command reference (`docs commands`) reads it, and so does the assistant.
 */

import type { CmdSpec } from '../../managers/exec/spec.ts';
import type { Access } from '../access/types.ts';
import { verifyAccess } from '../access/verify-access.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import type { ListedCommand } from '../api/docs.ts';

/** What the catalogue uses of a command: core's own and a module's (`@ein/client`) both are one. */
type Command = {
  readonly sys: { readonly vfs: NodeVFS };
  readonly env: Record<string, string>;
  readonly access: Access;
  execute(script: string): Promise<{ code: number; stdout: string; stderr: string }>;
};

export type CatalogueEntry = {
  name: string;
  /** The command node's id and change times: when they differ, the spec is asked again. */
  fingerprint: string;
  spec: CmdSpec;
  /** The PATH directory it was found in, which says whose it is: core's or a module's `bin`. */
  dir?: string;
};

const RELIST_MS = 60_000;
const CONCURRENCY = 4;
const CACHE_FILE = '.cache/commands.json';

type Catalogue = { commands: Map<string, CatalogueEntry>; listedAt: number; building?: Promise<void> };
const catalogues = new Map<string, Catalogue>();

const homeOf = (cmd: Command): string | undefined => {
  const home = typeof cmd.env.HOME === 'string' ? cmd.env.HOME.replace(/\/$/, '') : '';
  return home && home !== '/' ? home : undefined;
};

type Listed = { fingerprint: string; dir: string; script: boolean };

/** The node's id and change times, which a deploy or `mod setup` changes. */
const fingerprintOf = (node: Node): string => `${node.id}:${node.props.modtime?.timestamp ?? 0}:${node.props.changetime?.timestamp ?? 0}`;

/** Every command on PATH by name, first directory first as the shell finds them, with its fingerprint. */
const listPath = async (cmd: Command): Promise<Map<string, Listed>> => {
  const found = new Map<string, Listed>();
  for (const dir of [...new Set(String(cmd.env.PATH ?? '').split(':').filter(Boolean))]) {
    try {
      for (const entry of await cmd.sys.vfs.children(cmd.access, dir)) {
        // What the user may not run is not theirs to look up: an administrator's command refuses
        // its `--help` to anyone else.
        if (found.has(entry.name) || !verifyAccess(cmd.access, entry.node.props, 'x')) continue;
        found.set(entry.name, { fingerprint: fingerprintOf(entry.node), dir, script: entry.node.type === NODE_TYPE_FILE });
      }
    } catch {
      // A PATH entry that is not there lists nothing, as for the shell.
    }
  }
  return found;
};

const specOf = async (cmd: Command, name: string): Promise<CmdSpec | undefined> => {
  const ran = await cmd.execute(`JSON_OUTPUT=1 ${name} --help`);
  try {
    const spec = JSON.parse(`${ran.stdout ?? ''}`.trim()) as CmdSpec;
    return spec && typeof spec.name === 'string' ? spec : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether a script answers `--help` without running: a `#!ts` bin always does, from its spec; a
 * bash script when it begins with its `arg` declarations, which end the script at `arg --export`
 * when asked for help. Blank lines and comments may come first.
 */
export const declaresSpec = (source: string): boolean => {
  if (/^#!ts\r?\n/.test(source)) return true;
  const first = source.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  return first !== undefined && /^arg\s/.test(first);
};

/** The source of the script at `path`, read straight from the VFS; nothing when it cannot be read. */
const readScript = async (cmd: Command, path: string): Promise<string | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      return await new Response(handle.readable).text();
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

/** A command's spec from its `--help`; a script's only when it declares one. */
const askSpec = async (cmd: Command, name: string, dir: string, script: boolean): Promise<CmdSpec | undefined> => {
  if (script) {
    const source = await readScript(cmd, `${dir}/${name}`);
    if (source === undefined || !declaresSpec(source)) return undefined;
  }
  return await specOf(cmd, name);
};

/**
 * The kept catalogue, read straight from the VFS rather than through `cat`, which can cut a large
 * file short; a cut file is a JSON error and a rebuild.
 */
const loadCache = async (cmd: Command): Promise<CatalogueEntry[]> => {
  const home = homeOf(cmd);
  if (!home) return [];
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, `${home}/${CACHE_FILE}`, { mode: 'r' });
    let text: string;
    try {
      text = await new Response(handle.readable).text();
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(text) as { commands?: CatalogueEntry[] };
    return Array.isArray(parsed.commands) ? parsed.commands : [];
  } catch {
    return [];
  }
};

/** Best effort: a user who cannot write their home still has the catalogue for this process. */
const saveCache = async (cmd: Command, commands: CatalogueEntry[]): Promise<void> => {
  const home = homeOf(cmd);
  if (!home) return;
  try {
    const [dirName, fileName] = CACHE_FILE.split('/');
    await cmd.sys.vfs.ensure(cmd.access, 'directory', home, dirName);
    await cmd.sys.vfs.ensure(cmd.access, 'file', `${home}/${dirName}`, fileName, { attrs: { mimetype: 'application/json' } });
    const handle = await cmd.sys.vfs.open(cmd.access, `${home}/${CACHE_FILE}`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify({ commands })));
    } finally {
      await handle.close();
    }
  } catch {
    // Kept in memory regardless.
  }
};

/** Bring the user's catalogue up to date with their PATH: ask what is new or changed. */
const refresh = async (cmd: Command, catalogue: Catalogue): Promise<void> => {
  const listed = await listPath(cmd);
  if (catalogue.commands.size === 0) {
    for (const entry of await loadCache(cmd)) catalogue.commands.set(entry.name, entry);
  }
  let changed = false;
  for (const name of [...catalogue.commands.keys()]) {
    if (!listed.has(name)) {
      catalogue.commands.delete(name);
      changed = true;
    }
  }
  // Where a command is found can change without the command changing: a module's bin put ahead of core's.
  for (const [name, { dir }] of listed) {
    const known = catalogue.commands.get(name);
    if (known && known.dir !== dir) {
      known.dir = dir;
      changed = true;
    }
  }
  const stale = [...listed].filter(([name, { fingerprint }]) => catalogue.commands.get(name)?.fingerprint !== fingerprint);
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + CONCURRENCY).map(async ([name, { fingerprint, dir, script }]) => {
        const spec = await askSpec(cmd, name, dir, script);
        if (!spec) return;
        catalogue.commands.set(name, { name, fingerprint, spec, dir });
        changed = true;
      }),
    );
  }
  catalogue.listedAt = Date.now();
  if (changed) await saveCache(cmd, [...catalogue.commands.values()]);
};

/** The user's catalogue, refreshed when it is older than `RELIST_MS`. Concurrent callers share one refresh. */
export const commandCatalogue = async (cmd: Command): Promise<Map<string, CatalogueEntry>> => {
  const key = String(cmd.access.uid);
  let catalogue = catalogues.get(key);
  if (!catalogue) catalogues.set(key, catalogue = { commands: new Map(), listedAt: 0 });
  if (Date.now() - catalogue.listedAt >= RELIST_MS) {
    const current = catalogue;
    current.building ??= refresh(cmd, current).finally(() => current.building = undefined);
    await current.building;
  }
  return catalogue.commands;
};

/**
 * One command's spec, for a caller that has found it on PATH itself and cannot wait for the whole
 * catalogue: the catalogue's entry while the node is unchanged, otherwise asked of the command.
 */
export const commandSpec = async (
  cmd: Command,
  found: { name: string; dir: string; node: Node },
): Promise<CmdSpec | undefined> => {
  const known = catalogues.get(String(cmd.access.uid))?.commands.get(found.name);
  if (known && known.dir === found.dir && known.fingerprint === fingerprintOf(found.node)) return known.spec;
  return await askSpec(cmd, found.name, found.dir, found.node.type === NODE_TYPE_FILE);
};

/** Forget every catalogue: for tests, and for a rebuild on request. */
export const forgetCommandCatalogues = (): void => catalogues.clear();

/** `/usr/modules/<name>/bin` is that module's; anything else on PATH (`/usr/bin`, `/usr/lib/core/bin`) is core's. */
export const moduleOf = (dir: string | undefined, modPath: string): string => {
  const prefix = `${modPath.replace(/\/$/, '')}/`;
  if (!dir?.startsWith(prefix)) return 'core';
  const [name, bin, ...rest] = dir.slice(prefix.length).split('/').filter(Boolean);
  return name && bin === 'bin' && rest.length === 0 ? name : 'core';
};

/** Every command on the user's PATH with its whole spec and whose it is, by name. Hides nothing. */
export const listCommands = async (cmd: Command): Promise<ListedCommand[]> => {
  const modPath = typeof cmd.env.MOD_PATH === 'string' ? cmd.env.MOD_PATH : '/usr/modules';
  return [...(await commandCatalogue(cmd)).values()]
    .map((entry) => ({ name: entry.name, module: moduleOf(entry.dir, modPath), spec: entry.spec }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
