import { CORE_NODE_TYPES } from '../../../../lib/reference/node-types.ts';
import { NODE_TYPE_COMMAND } from '../../../../vfs/types/command.ts';
import type { NodeTypeDoc } from '../../../../lib/reference/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { describedBy } from './lib.ts';
import type { NodeTypeReference } from '../../../../lib/api/docs.ts';

/**
 * Every node type described or in use: a type nobody described still shows, with its count, so
 * the list cannot fall behind the archive.
 */
export const docsNodeTypes = async (cmd: Command): CmdReturn => {
  try {
    const [described, buckets] = await Promise.all([
      describedBy<NodeTypeDoc>(cmd, CORE_NODE_TYPES, 'nodeTypes'),
      cmd.sys.vfs.aggregate(cmd.access, { group: [{ column: 'type' }] }),
    ]);
    const counts = new Map<string, number>();
    for (const bucket of buckets) counts.set(bucket.key[0], (counts.get(bucket.key[0]) ?? 0) + bucket.count);
    // Command nodes are made on read from the registry, never stored, so no store counts them;
    // the registry says how many there are.
    counts.set(NODE_TYPE_COMMAND, cmd.sys.cem.list().length);

    const types = new Map<string, NodeTypeReference>();
    // The first description wins: core's own, then modules in name order.
    for (const doc of described) {
      if (!types.has(doc.type)) types.set(doc.type, { ...doc, count: counts.get(doc.type) ?? 0 });
    }
    for (const [type, count] of counts) {
      if (!types.has(type)) types.set(type, { type, count });
    }
    const result = [...types.values()].sort((a, b) => a.type.localeCompare(b.type));

    if (cmd.json) {
      await cmd.writeJSON(result);
    } else {
      for (const entry of result) {
        await cmd.writeLn(`${entry.type.padEnd(12)} ${String(entry.count).padStart(9)}  ${entry.owner ?? 'core'}${entry.description ? `  ${entry.description}` : ''}`);
      }
    }
    return 0;
  } catch (error) {
    await cmd.writeError(`docs node-types: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

docsNodeTypes.spec = {
  name: 'docs-node-types',
  effect: 'read' as const,
  description: 'List every node type, described or in use, with what it is for and how many exist',
  args: [],
  flags: [],
  examples: ['docs node-types'],
  returns: 'One entry per type: type, count, and label, description, category and owner module where it is described.',
};
