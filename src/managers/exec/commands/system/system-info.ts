/**
 * system-info — which instance this is and what it runs: host, core's version, the
 * module API, the commit and each module's, PostgreSQL's and Deno's versions, and uptime.
 *
 * The question it answers is usually "am I in production or on my laptop", or "is my change on
 * it yet", which nobody asks until something is confusing.
 */

import { join } from '@std/path';
import type { SystemInfo } from '../../../../lib/api/system.ts';
import { MOD_INSTALL_PATH, MOD_PATH } from '../../../../lib/paths.ts';
import { readInstallRecord } from '../../../../modules/install.ts';
import { MODULE_API_VERSION } from '../../../../modules/mod.ts';
import { REPO_ROOT } from '../../../../modules/repo.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** Core's own version. */
const CORE_VERSION = '0.1.0';

/** `3d 4h`, `5h 12m`, `42m` — uptime is read at a glance, not to the second. */
export const formatUptime = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

type Build = NonNullable<SystemInfo['build']>;

/** `git <args>` in `dir`, its output trimmed; nothing when git is missing or fails. */
const gitOut = async (dir: string, ...args: string[]): Promise<string | undefined> => {
  try {
    const { success, stdout } = await new Deno.Command('git', { args: ['-C', dir, ...args], stdout: 'piped', stderr: 'null' }).output();
    return success ? new TextDecoder().decode(stdout).trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Each module checkout under `modules/` and its commit, as `git describe --always --dirty` says it. */
const moduleCommits = async (): Promise<Record<string, string>> => {
  const commits: Record<string, string> = {};
  try {
    for await (const entry of Deno.readDir(join(REPO_ROOT, 'modules'))) {
      const commit = entry.isDirectory ? await gitOut(join(REPO_ROOT, 'modules', entry.name), 'describe', '--always', '--dirty', '--abbrev=9') : undefined;
      if (commit) commits[entry.name] = commit;
    }
  } catch {
    // No modules directory.
  }
  return Object.fromEntries(Object.entries(commits).sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * The commit the running tree and its modules are. A tree shipped without its `.git` carries
 * `src/build.json`, `{ "commit", "date", "modules" }`, written by whatever shipped it; a checkout
 * asks git. The tree does not change under a running process, so this is read once.
 */
const readBuild = async (): Promise<Build | undefined> => {
  try {
    const stamp = JSON.parse(await Deno.readTextFile(join(REPO_ROOT, 'src', 'build.json'))) as Partial<Build>;
    if (typeof stamp.commit === 'string' && typeof stamp.date === 'string') {
      return { commit: stamp.commit, date: stamp.date, ...(stamp.modules ? { modules: stamp.modules } : {}) };
    }
  } catch {
    // No stamp: a checkout.
  }
  const [commit, date] = (await gitOut(REPO_ROOT, 'log', '-1', '--format=%h %cI'))?.split(' ') ?? [];
  if (!commit || !date) return undefined;
  const modules = await moduleCommits();
  return { commit, date, ...(Object.keys(modules).length ? { modules } : {}) };
};

let build: Promise<Build | undefined> | undefined;

/** The commit of each module running from what `mod install` installed, as its install record has it. */
const installedCommits = async (cmd: Command): Promise<Record<string, string>> => {
  const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
  const store = cmd.env.MOD_INSTALL_PATH || MOD_INSTALL_PATH;
  const commits: Record<string, string> = {};
  try {
    for (const entry of await cmd.sys.vfs.children(cmd.access, modulesPath, { readlink: true })) {
      if (entry.node.props.softlink !== join(store, entry.name)) continue;
      const record = await readInstallRecord(cmd.sys.vfs, cmd.access, join(store, entry.name));
      if (record) commits[entry.name] = record.commit.slice(0, 9);
    }
  } catch {
    // No modules directory.
  }
  return commits;
};

/** The build with every module that runs: the tree's, and the installed ones. */
const withInstalled = (build: Build | undefined, installed: Record<string, string>): Build | undefined => {
  if (!build || Object.keys(installed).length === 0) return build;
  const modules = Object.fromEntries(Object.entries({ ...build.modules, ...installed }).sort(([a], [b]) => a.localeCompare(b)));
  return { ...build, modules };
};

/** `SHOW server_version`: `17.5`, or `17.5 (Debian 17.5-1.pgdg120+1)` as a distribution builds it. */
const databaseVersion = async (cmd: Command): Promise<string | undefined> => {
  if (!cmd.sys.pgPool) return undefined;
  try {
    const conn = await cmd.sys.pgPool.connect();
    try {
      const result = await conn.query<{ server_version: string }>('SHOW server_version');
      return result.rows[0]?.server_version;
    } finally {
      conn.release();
    }
  } catch {
    return undefined;
  }
};

/** What is known without asking anything: everything but the commit and the database. */
export const readSystemInfo = (): SystemInfo => {
  let hostname = '';
  try {
    hostname = Deno.hostname();
  } catch {
    // --allow-sys not granted.
  }

  return {
    hostname,
    version: CORE_VERSION,
    api: MODULE_API_VERSION,
    denoVersion: Deno.version.deno,
    // timeOrigin is when this process started, which is what "uptime" means
    // for an instance — Deno.osUptime() would report the machine's.
    uptimeMs: Math.round(performance.now()),
  };
};

export const systemInfo = async (cmd: Command): CmdReturn => {
  build ??= readBuild();
  const [tree, installed, database] = await Promise.all([build, installedCommits(cmd), databaseVersion(cmd)]);
  const commit = withInstalled(tree, installed);
  const info: SystemInfo = { ...readSystemInfo(), ...(commit ? { build: commit } : {}), ...(database ? { database } : {}) };

  if (cmd.json) {
    await cmd.writeJSON(info satisfies SystemInfo);
    return 0;
  }

  await cmd.writeLn(`host      ${info.hostname || '?'}`);
  await cmd.writeLn(`uptime    ${formatUptime(info.uptimeMs)}`);
  await cmd.writeLn(`core      ${info.version}${info.build ? ` (${info.build.commit}, ${info.build.date.slice(0, 10)})` : ''}`);
  await cmd.writeLn(`api       ${info.api}`);
  if (info.build?.modules) await cmd.writeLn(`modules   ${Object.entries(info.build.modules).map(([name, commit]) => `${name} ${commit}`).join(', ')}`);
  if (info.database) await cmd.writeLn(`postgres  ${info.database}`);
  await cmd.writeLn(`deno      ${info.denoVersion}`);
  return 0;
};

systemInfo.spec = {
  name: 'system-info',
  effect: 'read' as const,
  description: "Which instance this is: host name, uptime, core's version and commit, the module API, each module's commit, and the PostgreSQL and Deno versions",
  args: [],
};
