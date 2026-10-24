/**
 * Shared conformance suite for embedding registries. Reused by the memory
 * (fast tier) and PostgreSQL/pgvector (PG tier) implementations.
 *
 * Vectors are stored as text ("[1,0,0]") encoded to bytes, matching the
 * pgvector wire format.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import type { EmbeddingRegistryIf } from '../types.ts';

export type EmbeddingSetup = {
  registry: EmbeddingRegistryIf;
  teardown(): Promise<void>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function vec(values: number[]): Uint8Array {
  return enc.encode(`[${values.join(',')}]`);
}

async function writeEmbedding(registry: EmbeddingRegistryIf, id: string, embeddingType: string, values: number[]): Promise<void> {
  const handle = await registry.open(id, { embeddingType, capacity: values.length }, 'w');
  try {
    await handle.write(vec(values));
  } finally {
    await handle.close();
  }
}

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
};

export function embeddingConformanceTests(name: string, setup: () => Promise<EmbeddingSetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, teardown } = await setup();

    try {
      await t.step('write/read roundtrip preserves the vector', async () => {
        await writeEmbedding(registry, 'e1', 'rt', [1, 0, 0]);

        const handle = await registry.open('e1', { embeddingType: 'rt', capacity: 3 }, 'r');
        try {
          const data = await handle.read(0);
          const values = JSON.parse(dec.decode(data)) as number[];
          assertEquals(values, [1, 0, 0]);
        } finally {
          await handle.close();
        }
      });

      await t.step('stat reports type, vector size and byte size', async () => {
        const stat = await registry.stat('e1');
        assertEquals(stat.embeddingType, 'rt');
        assertEquals(stat.vectorSize, 3);
        assertEquals(stat.size > 0, true);
      });

      await t.step('invalid vector format is rejected', async () => {
        const handle = await registry.open('bad', { embeddingType: 'test', capacity: 3 }, 'w');
        try {
          await assertRejects(() => handle.write(enc.encode('not a vector')));
        } finally {
          await handle.close();
        }
      });

      await t.step('findSimilar orders matches by similarity', async () => {
        await writeEmbedding(registry, 'exact', 'test', [1, 0, 0]);
        await writeEmbedding(registry, 'close', 'test', [0.9, 0.1, 0]);
        await writeEmbedding(registry, 'far', 'test', [0, 0, 1]);

        const matches = await registry.findSimilar('test', vec([1, 0, 0]), 10, 0.5);
        const ids = matches.map((m) => m.id);

        assertEquals(ids[0], 'exact');
        assertEquals(ids.includes('close'), true);
        assertEquals(ids.includes('far'), false);

        // Similarities are descending and within [0, 1]
        for (let i = 1; i < matches.length; i++) {
          assertEquals(matches[i - 1].similarity >= matches[i].similarity, true);
        }
        assertEquals(matches[0].similarity > 0.99, true);
      });

      await t.step('findSimilar respects the limit', async () => {
        const matches = await registry.findSimilar('test', vec([1, 0, 0]), 1, 0.5);
        assertEquals(matches.length, 1);
        assertEquals(matches[0].id, 'exact');
      });

      await t.step('findSimilar can return more than the minimum HNSW search breadth', async () => {
        const count = 80;
        for (let i = 0; i < count; i++) {
          await writeEmbedding(registry, `wide-${i}`, 'wide', [1, 0, 0]);
        }

        const matches = await registry.findSimilar('wide', vec([1, 0, 0]), count, 0.99);
        assertEquals(matches.length, count);
      });

      await t.step('findSimilar within ranks only the given ids, the far one included', async () => {
        // 'test' holds exact[1,0,0], close[0.9,0.1,0], far[0,0,1]; a threshold of 0 keeps far.
        const matches = await registry.findSimilar('test', vec([1, 0, 0]), 10, 0, ['far', 'close', 'missing']);
        assertEquals(matches.map((m) => m.id), ['close', 'far']);
        assertEquals((await registry.findSimilar('test', vec([1, 0, 0]), 10, 0.5, ['far'])).length, 0);
        assertEquals((await registry.findSimilar('test', vec([1, 0, 0]), 10, 0, [])).length, 0);
      });

      await t.step('a threshold of -1 ranks every vector, the opposite one included', async () => {
        await writeEmbedding(registry, 'same', 'signed', [1, 0, 0]);
        await writeEmbedding(registry, 'opposite', 'signed', [-1, 0, 0]);
        for (const within of [undefined, ['same', 'opposite']]) {
          const matches = await registry.findSimilar('signed', vec([1, 0, 0]), 10, -1, within);
          assertEquals(matches.map((m) => m.id), ['same', 'opposite']);
          assertAlmostEquals(matches[1].similarity, -1, 1e-6);
        }
      });

      await t.step('findSimilar is isolated per embedding type', async () => {
        await writeEmbedding(registry, 'other-type', 'other', [1, 0, 0]);

        const matches = await registry.findSimilar('other', vec([1, 0, 0]), 10, 0.5);
        assertEquals(matches.map((m) => m.id), ['other-type']);
      });

      await t.step('findAllPairs returns near-neighbour edges both directions', async () => {
        // 'test' type holds exact[1,0,0], close[0.9,0.1,0], far[0,0,1].
        const pairs = await registry.findAllPairs('test', 10, 0.5);
        const has = (a: string, b: string) => pairs.some((p) => p.a === a && p.b === b);

        // exact and close are mutual neighbours; both directions present.
        assertEquals(has('exact', 'close'), true);
        assertEquals(has('close', 'exact'), true);
        // far is below threshold from both, so it appears in no edge.
        assertEquals(pairs.some((p) => p.a === 'far' || p.b === 'far'), false);
        // similarities are within [0, 1].
        for (const p of pairs) assertEquals(p.similarity > 0.5 && p.similarity <= 1.0000001, true);
      });

      await t.step('findAllPairs is isolated per embedding type', async () => {
        const pairs = await registry.findAllPairs('other', 10, 0.5);
        // 'other' holds a single embedding, so it has no neighbours.
        assertEquals(pairs, []);
      });

      await t.step('getVectors returns the requested vectors and skips the rest', async () => {
        const vectors = await registry.getVectors('test', ['exact', 'far', 'nope']);

        // 'nope' does not exist: absent, not an empty entry, so a caller can tell
        // "no vector" from "zero vector".
        assertEquals([...vectors.keys()].sort(), ['exact', 'far']);
        assertEquals(JSON.parse(dec.decode(vectors.get('exact')!)), [1, 0, 0]);
        assertEquals(JSON.parse(dec.decode(vectors.get('far')!)), [0, 0, 1]);

        // An empty request is not a query.
        assertEquals((await registry.getVectors('test', [])).size, 0);
      });

      await t.step('getVectors is isolated per embedding type', async () => {
        // 'exact' lives in type 'test', so asking 'other' for it must not find it.
        const vectors = await registry.getVectors('other', ['exact', 'other-type']);
        assertEquals([...vectors.keys()], ['other-type']);
      });

      await t.step('list and count include embeddings', async () => {
        const ids: string[] = [];
        for await (const id of await registry.list()) {
          ids.push(id);
        }

        assertEquals(ids.includes('e1'), true);
        assertEquals(await registry.count() >= 2, true);
      });

      await t.step('delete removes the embedding', async () => {
        assertEquals(await registry.delete('e1'), true);
        assertEquals(await registry.exists('e1'), false);
        assertEquals(await registry.delete('e1'), false);

        const matches = await registry.findSimilar('rt', vec([1, 0, 0]), 10, 0.5);
        assertEquals(matches.some((m) => m.id === 'e1'), false);
      });
    } finally {
      await teardown();
    }
  });
}
