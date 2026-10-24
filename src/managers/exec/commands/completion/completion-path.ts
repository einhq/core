import { basename, dirname, join, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { verifyAccess } from '../../../../lib/access/mod.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { printWords } from './lib/utils.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';

export const completePath = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['word'],
  });
  const word = flags.word || '';

  try {
    // The directory to list, and the prefix its children must match.
    let searchDir: string;
    let prefix: string;
    let wordPrefix: string; // The part of the word before the name

    if (word === '') {
      searchDir = cmd.cwd;
      prefix = word;
      wordPrefix = '';
    } else if (word === '.') {
      searchDir = cmd.cwd;
      prefix = word;
      wordPrefix = './';
    } else if (word === '..') {
      searchDir = resolve(cmd.cwd, '..');
      prefix = '';
      wordPrefix = '../';
    } else if (word.endsWith('/')) {
      searchDir = resolve(cmd.cwd, word);
      prefix = '';
      wordPrefix = word;
    } else {
      const dir = dirname(word);
      searchDir = resolve(cmd.cwd, dir);
      prefix = basename(word);
      wordPrefix = dir === '.' ? '' : (dir + '/');
    }

    const entries = await cmd.sys.vfs.children(cmd.access, searchDir);
    const completions: string[] = [];

    for (const entry of entries) {
      if (!verifyAccess(cmd.access, entry.node.props, 'x')) {
        continue;
      }

      if (!entry.name.startsWith(prefix)) {
        continue;
      }

      // Every node can hold children, so `[ -d ]` (and `compgen -d`) is true for all of them.
      // A directory is marked so the Tab carries on into it; any other node once its whole
      // name is typed, which is how a file's thumbnails are reached.
      const trailingSlash = entry.node.type === NODE_TYPE_DIRECTORY || entry.name === prefix;
      const path = join(wordPrefix, entry.name) + (trailingSlash ? '/' : '');

      if (word.startsWith('./')) {
        completions.push(`./${path}`);
      } else {
        completions.push(path);
      }
    }

    await printWords(cmd, completions);
  } catch {
    // No such directory, or no access: no completions.
  }

  return 0;
};

completePath.spec = {
  name: 'completion-path',
  effect: 'read' as const,
  json: false,
  description: 'Autocomplete a path',
  flags: [
    {
      name: 'word',
      type: 'string' as const,
      description: 'Word to autocomplete',
    },
  ],
};
