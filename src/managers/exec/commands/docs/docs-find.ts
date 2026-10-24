/**
 * docs find — commands by what they do, best first. The command the `CFG_COMMAND_FINDER` setting
 * names answers when there is one; core only asks it, so the documentation's search names no
 * module. With none set, core matches the words against every command's name and description.
 */
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { CommandFind, CommandHit } from '../../../../lib/api/docs.ts';
import { listCommands } from '../../../../lib/commands/catalogue.ts';
import { readSettings } from '../../../../lib/config/read-settings.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DEFAULT_LIMIT = 10;

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);

/**
 * Commands by their words: the share of the query's words found in a command's name, description
 * and returns, a word in the name counting double. Crude beside meaning, and enough to find
 * `media-rotate` for "rotate".
 */
const findByWords = async (cmd: Command, words: string, limit: number): Promise<CommandHit[]> => {
  const query = wordsOf(words);
  if (query.length === 0) return [];
  const hits: CommandHit[] = [];
  for (const { name, spec } of await listCommands(cmd)) {
    const inName = new Set(wordsOf(name));
    const inText = new Set(wordsOf(`${spec.description ?? ''} ${spec.returns ?? ''}`));
    const points = query.reduce((sum, word) => sum + (inName.has(word) ? 2 : inText.has(word) ? 1 : 0), 0);
    if (points === 0) continue;
    hits.push({ name, description: spec.description, ...(spec.effect ? { effect: spec.effect } : {}), score: points / (2 * query.length) });
  }
  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
};

export const docsFind = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['limit'], alias: { l: 'limit' } });
  const words = flags._.map(String).join(' ').trim();
  if (!words) {
    await cmd.writeError('docs find: what should the command do?\n');
    return 2;
  }
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;

  let answer: CommandFind;
  // Read now rather than from this shell's environment: the web UI's shell outlives a settings change.
  const finder = (await readSettings(cmd, cmd.access, { user: false })).CFG_COMMAND_FINDER?.trim();
  if (finder) {
    const run = await cmd.execute(`JSON_OUTPUT=1 ${finder} find ${shq(words)}${limit !== undefined && limit > 0 ? ` --limit ${limit}` : ''}`);
    if (run.code !== 0) {
      await cmd.writeError(`docs find: ${finder}: ${run.stderr.trim() || `exit ${run.code}`}\n`);
      return run.code;
    }
    answer = JSON.parse(run.stdout) as CommandFind;
  } else {
    answer = { hits: await findByWords(cmd, words, limit !== undefined && limit > 0 ? limit : DEFAULT_LIMIT) };
  }

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies CommandFind);
    return 0;
  }
  for (const hit of answer.hits) await cmd.writeLn(`${hit.score.toFixed(2)}  ${hit.name.padEnd(24)} ${hit.description ?? ''}`);
  return 0;
};

docsFind.spec = {
  name: 'docs-find',
  effect: 'read' as const,
  description: 'Commands by what they do, best first: by the command CFG_COMMAND_FINDER names, else by their words',
  args: [{ name: 'words', type: 'string' as const, variadic: true, description: 'What the command should do' }],
  flags: [{ name: 'limit', type: 'number' as const, description: 'How many commands' }],
};
