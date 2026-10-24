import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { QueuePeekEntry } from '../../../../lib/api/mod.ts';

const DEFAULT_LIMIT = 10;
/** A payload wider than this is cut in the table; JSON mode carries it whole. */
const DATA_WIDTH = 80;

/**
 * Look at a queue without consuming it.
 *
 * `cat` on a queue reads it, and a queue read is a claim: every entry printed
 * is gone. This lists the next entries in the order a consumer would get them,
 * the one a consumer holds included, and leaves them all where they are.
 */
export const queuePeek = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['limit'],
    alias: { n: 'limit' },
  });

  const pathArg = flags._[0] as string | undefined;

  if (!pathArg) {
    await cmd.writeError('queue-peek: missing queue path\n');
    return 1;
  }

  const path = resolve(cmd.cwd, pathArg);

  try {
    const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`invalid --limit '${flags.limit}'`);
    }

    const items = await cmd.sys.vfs.queuePeek(cmd.access, path, limit);

    if (cmd.json) {
      // Dates cross as ISO strings: `QueuePeek` is `Wire<…>` of exactly this.
      await cmd.writeJSON({ items } satisfies { items: QueuePeekEntry[] });
      return 0;
    }

    if (items.length === 0) {
      await cmd.write('Empty\n');
      return 0;
    }

    const color = colorer(!cmd.tty);
    const table = new Table({
      header: true,
      columns: [
        { name: 'ID', align: 'right' },
        { name: 'STATE', align: 'left' },
        { name: 'TRY', align: 'right' },
        { name: 'CREATED', align: 'left' },
        { name: 'KEY', align: 'left' },
        { name: 'DATA', align: 'left' },
      ],
    });

    for (const item of items) {
      const data = JSON.stringify(item.data);
      table.addRow({
        ID: String(item.id),
        STATE: color(item.state === 'ready' ? 'green' : 'yellow', item.state),
        TRY: String(item.attempts),
        CREATED: item.createdAt.toISOString(),
        KEY: item.routingKey,
        DATA: data.length > DATA_WIDTH ? `${data.slice(0, DATA_WIDTH - 1)}…` : data,
      });
    }

    await cmd.write(table.render());
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`queue-peek: ${path}: ${message}\n`);
    return 1;
  }
};

queuePeek.spec = {
  name: 'queue-peek',
  effect: 'read' as const,
  description: 'List the next entries of a queue without consuming them',
  args: [
    { name: 'path', type: 'path' as const, description: 'Queue node path' },
  ],
  flags: [
    { name: 'n', type: 'string' as const, description: `how many entries, from the front (default ${DEFAULT_LIMIT})` },
    { name: 'limit', type: 'string' as const, description: `how many entries, from the front (default ${DEFAULT_LIMIT})` },
  ],
  examples: ['queue-peek -n 20 /pipelines/queues/example'],
  returns: 'the next entries in delivery order: id, state (ready or in-flight), attempts, created, routing key and data; in JSON mode { items }.',
};
