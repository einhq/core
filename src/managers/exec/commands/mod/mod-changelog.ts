/**
 * mod changelog — the commits of an installed module's repository, newest first, from what an
 * update would install (as `mod outdated` has it) down past the commit installed: the ones an
 * update brings, then the installed one and those before it, each with the release tags on it.
 * A module installed from GitHub has the daily published summaries for commits; one from Forgejo
 * the commits themselves. A module `mod install` did not fetch has no repository to ask.
 */

import { join } from '@std/path';
import type { ChangelogCommit, ModuleChangelog } from '../../../../lib/api/mod.ts';
import { MOD_PATH } from '../../../../lib/paths.ts';
import { mayUseModule } from '../../../../modules/audience.ts';
import { fetchHistory, parseRepository, type Refs } from '../../../../modules/forge.ts';
import { readInstallRecord } from '../../../../modules/install.ts';
import { readModJson } from '../../../../modules/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { checkInstalled } from './mod-outdated.ts';
import { FORGE_TIMEOUT_MS, moduleSources, within } from './sources.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Each commit's release tags, `v<…>`, an annotated tag by the commit it points to. */
const tagsByCommit = (refs: Refs): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const [name, commit] of refs.refs) {
    const tag = /^refs\/tags\/(v[^^]+)$/.exec(name)?.[1];
    if (!tag) continue;
    const at = refs.refs.get(`${name}^{}`) ?? commit;
    found.set(at, [...found.get(at) ?? [], tag]);
  }
  return found;
};

const short = (commit: string): string => commit.slice(0, 9);

export const modChangelog = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['limit'] });
  const name = flags._.map(String)[0];
  if (!name) {
    await cmd.writeError('mod changelog: name an installed module\n');
    return 1;
  }
  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    await cmd.writeError(`mod changelog: --limit takes a whole number from 1 to ${MAX_LIMIT}\n`);
    return 1;
  }

  const path = join(cmd.env.MOD_PATH || MOD_PATH, name);
  const manifest = await readModJson(cmd.sys.vfs, cmd.access, path);
  if (!manifest || !await mayUseModule(cmd.sys.vfs, cmd.access, name)) {
    await cmd.writeError(`mod changelog: no module ${name} is installed\n`);
    return 1;
  }
  const record = await readInstallRecord(cmd.sys.vfs, cmd.access, path);
  if (!record) {
    await cmd.writeError(`mod changelog: ${name} was not fetched by mod install, so there is no repository to ask\n`);
    return 1;
  }

  const { insecure, tokens, prereleases } = await moduleSources(cmd);
  let checked;
  let history;
  try {
    checked = await checkInstalled(cmd, name, manifest.version ?? null, record, { insecure, tokens }, prereleases);
    const repository = parseRepository(record.repository, insecure)!;
    const from = checked.module.behind ? checked.module.latest.commit : record.commit;
    history = await fetchHistory(repository, from, limit + 1, tokens, within(cmd, FORGE_TIMEOUT_MS));
  } catch (error) {
    await cmd.writeError(`mod changelog: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const tags = tagsByCommit(checked.refs);
  const reached = history.findIndex((each) => each.commit === record.commit);
  const commits = history.slice(0, limit).map((each, index): ChangelogCommit => {
    const [subject, ...rest] = each.message.split('\n');
    return {
      commit: each.commit,
      subject: subject.trim(),
      body: rest.join('\n').trim(),
      date: each.date,
      tags: tags.get(each.commit) ?? [],
      installed: each.commit === record.commit,
      coming: checked.module.behind && (reached < 0 || index < reached),
    };
  });
  const { latest } = checked.module;
  const answer = {
    name,
    repository: record.repository,
    installed: { version: manifest.version ?? null, ref: record.ref, commit: record.commit },
    latest: checked.module.behind ? latest : { ref: record.ref, commit: record.commit, ...(manifest.version ? { version: manifest.version } : {}) },
    commits,
    more: history.length > limit,
  } satisfies ModuleChangelog;

  if (cmd.json) {
    await cmd.writeJSON(answer);
    return 0;
  }
  for (const commit of commits) {
    const marks = [...commit.tags, ...(commit.installed ? ['installed'] : []), ...(commit.coming ? ['coming'] : [])];
    await cmd.write(`${short(commit.commit)} ${commit.date.slice(0, 10)} ${commit.subject}${marks.length ? ` (${marks.join(', ')})` : ''}\n`);
  }
  if (commits.length > 0 && !commits.some((each) => each.installed)) await cmd.write(`The installed commit ${short(record.commit)} is not among these ${commits.length}\n`);
  return 0;
};

modChangelog.spec = {
  name: 'mod-changelog',
  effect: 'read' as const,
  description:
    "An installed module's commits, newest first, from what an update would install down past the one installed, each with its release tags; marked which is installed and which an update brings",
  args: [{ name: 'module', type: 'string' as const, description: 'The installed module' }],
  flags: [{ name: 'limit', type: 'number' as const, description: `How many commits at most; ${DEFAULT_LIMIT} when not given, at most ${MAX_LIMIT}` }],
};
