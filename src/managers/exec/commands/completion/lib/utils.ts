import { ADMIN_ACCESS, verifyAccess } from '../../../../../lib/access/mod.ts';
import { type Node, type NodeType } from '../../../../../vfs/mod.ts';
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
type PathCommand = { name: string; node: Node; dir: string };

/** The PATH directories, once each, in the order the shell searches them. */
const pathDirs = (cmd: Command): string[] => [...new Set(cmd.env.PATH.split(':').filter(Boolean))];

/** Whether the user may run `node`. */
const runnable = (cmd: Command, node: Node): boolean => EXECUTABLE_NODE_TYPES.includes(node.type) && verifyAccess(cmd.access, node.props, 'x');

/** Every command on PATH the user may run, by name. */
export const listCommands = async (cmd: Command): Promise<PathCommand[]> => {
  const entries = (await Promise.all(
    pathDirs(cmd).map(async (dir) => {
      try {
        return (await cmd.sys.vfs.children(ADMIN_ACCESS, dir)).map(({ name, node }) => ({ name, node, dir }));
      } catch {
        // A PATH entry that is not there lists nothing, as for the shell.
        return [];
      }
    }),
  )).flat();

  const completions = entries.filter((e) => runnable(cmd, e.node));

  completions.sort((a, b) => a.name.localeCompare(b.name));

  return completions;
};

/** The command `name` runs, as the shell finds it: the first PATH directory holding one the user may run. */
export const findCommand = async (cmd: Command, name: string): Promise<PathCommand | undefined> => {
  if (!name || name.includes('/') || name === '.' || name === '..') return undefined;

  const dirs = pathDirs(cmd);
  const nodes = await Promise.all(dirs.map((dir) => cmd.sys.vfs.get(ADMIN_ACCESS, `${dir}/${name}`).catch(() => undefined)));
  const i = nodes.findIndex((node) => node && runnable(cmd, node));

  return i < 0 ? undefined : { name, node: nodes[i]!, dir: dirs[i] };
};
