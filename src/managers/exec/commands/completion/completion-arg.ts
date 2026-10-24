import { parseArgs } from '../../../../lib/args/mod.ts';
import { Node } from '../../../../vfs/mod.ts';
import { CommandAttrs, NODE_TYPE_COMMAND } from '../../../../vfs/types/command.ts';
import { Command } from '../../command.ts';
import { CmdReturn, CmdSpec } from '../../types.ts';
import { commandSpec } from '../../../../lib/commands/catalogue.ts';
import { listCommands, printWords } from './lib/utils.ts';

export const completeArg = async (cmd: Command): CmdReturn => {
  try {
    const flags = parseArgs(cmd.args, {
      string: ['word'],
    });
    const positionalArgs = flags._ as string[];
    const word = flags.word || '';

    const command = positionalArgs[0];

    if (!command) {
      await cmd.writeError('completion-arg: missing command argument');
      return 1;
    }

    if (!cmd.env.PATH) {
      return 0;
    }

    const entries = await listCommands(cmd);
    const cmdNode = entries.find((e) => e.name === command);

    if (!cmdNode) {
      const strArgs = positionalArgs.map((a) => `"${a}"`).join(' ');
      // Not a command on PATH (a shell builtin, say): paths, as bash does for an unknown.
      return cmd.executeInline(`completion-path ${strArgs} --word="${word}"`);
    }

    // A command node carries its spec; a script is asked for the one it declares.
    const spec: CmdSpec | undefined = cmdNode.node.type === NODE_TYPE_COMMAND ? (cmdNode.node as Node<CommandAttrs>).attrs : await commandSpec(cmd, cmdNode);
    const script = cmdNode.node.type !== NODE_TYPE_COMMAND;

    if (!spec) {
      // A script that declares no spec: paths, as for an unknown.
      const strArgs = positionalArgs.map((a) => `"${a}"`).join(' ');
      return cmd.executeInline(`completion-path ${strArgs} --word="${word}"`);
    }

    const specArgs = spec.args || [];
    const specFlags = spec.flags || [];

    // A group's subcommand completes as the routed command. A script says it is a group
    // (`arg --group`) rather than typing its first argument.
    if ((spec.group || specArgs[0]?.type === 'subcommand') && positionalArgs.length > 1) {
      const subcommand = positionalArgs[1];
      const strArgs = [
        `${command}-${subcommand}`,
        ...positionalArgs.slice(2),
      ].map((a) => `"${a}"`).join(' ');
      return cmd.executeInline(`completion-arg ${strArgs} --word="${word}"`);
    }

    if (word.startsWith('-')) {
      if (specFlags.length === 0) {
        return 0;
      }

      if (word.includes('=')) {
        // Only typed (double dash) flags can have values
        if (!word.startsWith('--')) {
          return 0;
        }

        const [flagName, value] = word.split('=');
        const flagSpec = specFlags.find((d) => d.name === flagName.replaceAll('--', ''));

        if (!flagSpec || !flagSpec.type) {
          return 0;
        }

        const strArgs = positionalArgs.map((a) => `"${a}"`).join(' ');
        const res = await cmd.execute(`completion-${flagSpec.type} ${strArgs} --word="${value}"`);

        if (res.code !== 0) {
          await cmd.writeError(res.stderr);
          return res.code;
        }

        await printWords(cmd, res.stdout.split('\n').filter(Boolean).map((s) => `--${flagSpec.name}=${s}`));

        return 0;
      }

      const flagNames: string[] = [];
      for (const flag of specFlags) {
        if (flag.type) { // Typed flags always begin with --
          flagNames.push('-' + flag.name);
        } else { // Boolean flags always begin with -
          flagNames.push(flag.name);
        }
      }

      const completions = flagNames
        .map((flag: string) => `-${flag}`)
        .filter((flag: string) => flag.startsWith(word));

      // The one typed flag left is completed ready for its value
      await printWords(cmd, completions.length === 1 && completions[0].startsWith('--') ? [`${completions[0]}=`] : completions);
    }

    // The command name is always there, so this is never below 0.
    const pos = positionalArgs.length - 1;
    // Past the declared arguments, the last one carries on if it is variadic
    // (`mknode -t directory /a /b`); otherwise there is nothing to complete.
    const last = specArgs[specArgs.length - 1];
    const argSpec = specArgs[pos] ?? (last?.variadic ? last : undefined);

    if (!argSpec && script && !word.startsWith('-')) {
      // A script's spec leaves out what it hands on (`arg --rest`): paths, as for an unknown.
      const strArgs = positionalArgs.map((a) => `"${a}"`).join(' ');
      return cmd.executeInline(`completion-path ${strArgs} --word="${word}"`);
    }

    if (!argSpec) {
      return 0;
    }

    // A group's first argument is its subcommand, whatever type a script gave it.
    const type = pos === 0 && spec.group ? 'subcommand' : argSpec.type;

    if (['string', 'number'].includes(type)) {
      return 0;
    }

    const strArgs = positionalArgs.map((a) => `"${a}"`).join(' ');
    return cmd.executeInline(`completion-${type} ${strArgs} --word="${word}"`);
  } catch (error) {
    console.error(error);
    throw error;
  }
};

completeArg.spec = {
  name: 'completion-arg',
  effect: 'read' as const,
  json: false,
  description: 'Autocomplete a command argument',
  flags: [
    {
      name: 'word',
      type: 'string' as const,
      description: 'Word to autocomplete',
    },
  ],
};
