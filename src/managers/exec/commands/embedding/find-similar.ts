import { resolve } from '@std/path';
import { toArrayBuffer } from '@std/streams/to-array-buffer';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { EmbeddingAttrs } from '../../../../vfs/types/embedding.ts';
import { NODE_TYPE_EMBEDDING } from '../../../../vfs/types/embedding.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { SimilarAnswer } from '../../../../lib/api/mod.ts';

/**
 * find-similar — the embeddings of the same type nearest to one embedding node, nearest first,
 * with where each is linked. `--limit` caps how many; the store's own default otherwise.
 */
export const findSimilar = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['limit'] });
  const path = resolve(cmd.cwd, flags._[0] as string || '.');
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);

  try {
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit takes a positive whole number');
    const node = await cmd.sys.vfs.get(cmd.access, path);

    if (node.type !== NODE_TYPE_EMBEDDING) {
      throw new Error(`node type is not ${NODE_TYPE_EMBEDDING}`);
    }

    const attrs = node.attrs as EmbeddingAttrs;
    const embeddingType = attrs.embeddingType;
    if (!embeddingType) {
      throw new Error('node missing embeddingType attribute');
    }

    const handle = await cmd.sys.vfs.open(cmd.access, path);

    try {
      const embedding = await toArrayBuffer(handle.readable);
      if (!embedding) {
        throw new Error(`node has no embedding`);
      }

      const similar = await cmd.sys.vfs.findSimilar(cmd.access, embeddingType, new Uint8Array(embedding), limit);

      if (cmd.json) {
        const entries = await cmd.sys.vfs.resolveIdEntries(cmd.access, similar.map((s) => s.id));
        const answer = {
          hits: similar.map((s) => ({ id: s.id, similarity: s.similarity, paths: (entries.get(s.id) ?? []).map((entry) => entry.path) })),
        } satisfies SimilarAnswer;
        await cmd.writeJSON(answer);
        return 0;
      }

      for (const s of similar) {
        await cmd.write(`Match with score ${s.similarity} [${s.id}]:\n`);
        const entries = await cmd.sys.vfs.resolveId(cmd.access, s.id);

        for (const e of entries) {
          await cmd.write(` - ${e.absPath}\n`);
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ error: `find-similar: ${message}` });
    } else {
      await cmd.writeError(`find-similar: ${message}\n`);
    }
    return 1;
  }

  return 0;
};

findSimilar.spec = {
  name: 'find-similar',
  effect: 'read' as const,
  description: 'Find similar nodes by embedding',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path of embedding node',
    },
  ],
  flags: [{ name: 'limit', type: 'number' as const, description: 'at most this many matches' }],
  returns: 'the nearest embeddings with their similarity and paths, as JSON (SimilarAnswer).',
};
