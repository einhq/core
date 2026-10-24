import { ADMIN_ACCESS, verifyAccess } from '../../../../../lib/access/mod.ts';
import { NodeChildEntry, type NodeType } from '../../../../../vfs/mod.ts';
import { NODE_TYPE_COMMAND } from '../../../../../vfs/types/command.ts';
import { NODE_TYPE_FILE } from '../../../../../vfs/types/file.ts';
import { Command } from '../../../command.ts';

const EXECUTABLE_NODE_TYPES: NodeType[] = [
  NODE_TYPE_COMMAND,
  NODE_TYPE_FILE,
];

/**
 * Print completion candidates the way every `completion-*` command answers: one
 * per line, a directory with its trailing `/`.
 */
export const printWords = async (cmd: Command, words: string[]): Promise<void> => {
  if (words.length > 0) await cmd.write(`${words.join('\n')}\n`);
};

/** A command found on PATH, with the directory it was found in. */
type PathCommand = NodeChildEntry & { dir: string };

export const listCommands = async (cmd: Command): Promise<PathCommand[]> => {
  const entries = (await Promise.all(
    [...new Set(cmd.env.PATH.split(':').filter(Boolean))].map(async (dir) => {
      try {
        return (await cmd.sys.vfs.children(ADMIN_ACCESS, dir)).map((entry) => ({ ...entry, dir }));
      } catch {
        return [];
      }
    }),
  )).flat();

  const completions = entries
    .filter((e) => EXECUTABLE_NODE_TYPES.includes(e.node.type))
    .filter((e) => verifyAccess(cmd.access, e.node.props, 'x'));

  completions.sort((a, b) => a.name.localeCompare(b.name));

  return completions;
};
