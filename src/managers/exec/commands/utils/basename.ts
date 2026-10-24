import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const basename = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      s: 'suffix',
      a: 'multiple',
      z: 'zero',
    },
    string: ['s'],
    boolean: ['a', 'z'],
  });

  const paths = flags._ as string[];
  const suffix = flags.suffix ?? (flags._.length > 1 && !flags.multiple ? String(flags._[1]) : '');

  if (paths.length === 0) {
    await cmd.writeError('basename: missing operand\n');
    return 1;
  }

  const terminator = flags.zero ? '\0' : '\n';

  // Without -a, a second operand is the suffix.
  const pathsToProcess = !flags.multiple && paths.length > 1 ? [paths[0]] : paths;

  for (const path of pathsToProcess) {
    let name = path.replace(/\/+$/, '');

    const lastSlash = name.lastIndexOf('/');
    if (lastSlash !== -1) {
      name = name.slice(lastSlash + 1);
    }

    // `/` alone.
    if (name === '') {
      name = '/';
    }

    if (suffix && name.endsWith(suffix) && name !== suffix) {
      name = name.slice(0, -suffix.length);
    }

    await cmd.write(`${name}${terminator}`);
  }

  return 0;
};

basename.spec = {
  name: 'basename',
  effect: 'read' as const,
  json: false,
  description: 'Strip directory and suffix from filenames',
  args: [
    {
      name: 'NAME',
      type: 'path' as const,
      description: 'the path to extract basename from',
    },
    {
      name: 'SUFFIX',
      type: 'string' as const,
      description: 'optional suffix to remove',
    },
  ],
  flags: [
    { name: 's', type: 'string' as const, description: 'remove a trailing SUFFIX' },
    { name: 'a', type: 'bool' as const, description: 'support multiple arguments' },
    { name: 'z', type: 'bool' as const, description: 'end each output line with NUL, not newline' },
  ],
};
