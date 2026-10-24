import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { Table } from '../../../shell/terminal/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { QueueDeadEntry } from '../../../../lib/api/mod.ts';

const DEFAULT_LIMIT = 10;
/** A payload wider than this is cut in the table; JSON mode carries it whole. */
const DATA_WIDTH = 80;

/**
 * The entries a queue set aside after they ran out of delivery attempts, and what to do with them.
 *
 * A dead letter is never handed out again and keeps `health` failing until a person decides:
 * `--retry` puts it back in line with no attempts spent, for a failure that is fixed now;
 * `--drop` deletes it, for work that no longer matters. Without either it lists them.
 */
export const queueDead = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['retry', 'drop'],
    string: ['limit'],
    collect: ['id'],
    alias: { n: 'limit' },
  });

  const pathArg = flags._[0] as string | undefined;

  if (!pathArg) {
    await cmd.writeError('queue-dead: missing queue path\n');
    return 1;
  }

  const path = resolve(cmd.cwd, pathArg);

  try {
    if (flags.retry && flags.drop) throw new Error('--retry and --drop exclude each other');

    const ids = (flags.id as string[] | undefined)?.map((value) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid --id '${value}'`);
      return id;
    });

    if (flags.retry || flags.drop) {
      const settled = await cmd.sys.vfs.queueSettleDead(cmd.access, path, flags.retry ? 'retry' : 'drop', ids);

      if (cmd.json) {
        await cmd.writeJSON({ ok: true, settled });
      } else {
        await cmd.write(`${settled} ${settled === 1 ? 'entry' : 'entries'} ${flags.retry ? 'put back in line' : 'dropped'}\n`);
      }
      return 0;
    }

    if (ids) throw new Error('--id needs --retry or --drop');

    const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`invalid --limit '${flags.limit}'`);
    }

    const items = await cmd.sys.vfs.queueDead(cmd.access, path, limit);

    if (cmd.json) {
      // Dates cross as ISO strings: `QueueDead` is `Wire<…>` of exactly this.
      await cmd.writeJSON({ items } satisfies { items: QueueDeadEntry[] });
      return 0;
    }

    if (items.length === 0) {
      await cmd.write('None\n');
      return 0;
    }

    const table = new Table({
      header: true,
      columns: [
        { name: 'ID', align: 'right' },
        { name: 'TRY', align: 'right' },
        { name: 'CREATED', align: 'left' },
        { name: 'DEAD', align: 'left' },
        { name: 'KEY', align: 'left' },
        { name: 'DATA', align: 'left' },
      ],
    });

    for (const item of items) {
      const data = JSON.stringify(item.data);
      table.addRow({
        ID: String(item.id),
        TRY: String(item.attempts),
        CREATED: item.createdAt.toISOString(),
        DEAD: item.deadAt.toISOString(),
        KEY: item.routingKey,
        DATA: data.length > DATA_WIDTH ? `${data.slice(0, DATA_WIDTH - 1)}…` : data,
      });
    }

    await cmd.write(table.render());
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`queue-dead: ${path}: ${message}\n`);
    return 1;
  }
};

queueDead.spec = {
  name: 'queue-dead',
  effect: 'read' as const,
  description: 'List the entries a queue set aside after their delivery attempts, or retry or drop them',
  args: [
    { name: 'path', type: 'path' as const, description: 'Queue node path' },
  ],
  flags: [
    { name: 'retry', type: 'bool' as const, writes: true, description: 'put them back in line with no attempts spent' },
    { name: 'drop', type: 'bool' as const, writes: true, description: 'delete them' },
    { name: 'id', type: 'string' as const, description: 'only this entry, with --retry or --drop (repeatable)' },
    { name: 'n', type: 'string' as const, description: `how many entries to list (default ${DEFAULT_LIMIT})` },
    { name: 'limit', type: 'string' as const, description: `how many entries to list (default ${DEFAULT_LIMIT})` },
  ],
  examples: ['queue-dead /var/queues/archive-bridge', 'queue-dead --retry /var/queues/archive-bridge', 'queue-dead --drop --id 42 /var/queues/archive-bridge'],
  returns:
    'the dead-lettered entries: id, attempts, created, dead, routing key and data; in JSON mode { items }. With --retry or --drop, how many were settled; in JSON mode { ok, settled }.',
};
