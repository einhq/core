/**
 * parse-search — a search's words read as filters: subjects, an area, years and kinds.
 *
 * The reading is the command the `CFG_SEARCH_PARSER` setting names; core only asks it, so the
 * search box names no module. With no parser set the words stay words: the answer is the text as
 * it was, and the box searches it as a description. `--rules` asks the parser for its fast pass
 * only, which the box applies at once while the full read is on its way.
 */
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { SearchParse } from '../../../../lib/api/search.ts';
import { readSettings } from '../../../../lib/config/read-settings.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** The words as they are: what a box without a parser searches. */
const asWords = (text: string): SearchParse => ({ text, kinds: [], subjects: [], unresolved: [], source: 'none', explain: '' });

export const parseSearch = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['rules'] });
  const text = flags._.map(String).join(' ').trim();
  if (!text) {
    await cmd.writeError('parse-search: what to read?\n');
    return 2;
  }

  // Read now rather than from this shell's environment: the web UI's shell outlives a settings change.
  const parser = (await readSettings(cmd, cmd.access, { user: false })).CFG_SEARCH_PARSER?.trim();
  let answer = asWords(text);
  if (parser) {
    const run = await cmd.execute(`JSON_OUTPUT=1 ${parser}${flags.rules ? ' --rules' : ''} ${shq(text)}`);
    if (run.code !== 0) {
      await cmd.writeError(`parse-search: ${parser}: ${run.stderr.trim() || `exit ${run.code}`}\n`);
      return run.code;
    }
    answer = JSON.parse(run.stdout) as SearchParse;
  }

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies SearchParse);
    return 0;
  }
  await cmd.writeLn(answer.explain || answer.text);
  return 0;
};

parseSearch.spec = {
  name: 'parse-search',
  effect: 'read' as const,
  description: "A search's words read as filters — subjects, an area, years, kinds — by the command CFG_SEARCH_PARSER names, or as words when it names none",
  args: [{ name: 'words', type: 'string', variadic: true, description: 'What was typed into the search box' }],
  flags: [{ name: 'rules', type: 'bool', description: "The parser's fast pass only, without its model" }],
};
