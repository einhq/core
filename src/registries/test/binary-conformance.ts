/**
 * Shared conformance suite for binary registries (blob, file).
 *
 * Parameterized over a factory so the same behavior is pinned for the memory
 * implementations (fast tier) and the PostgreSQL/disk ones (PG tier).
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { RegistryIf, ResourceOptions } from '../types.ts';
import { ResourceSeekMode } from '../types.ts';

export type BinarySetup = {
  registry: RegistryIf<
    ResourceOptions,
    { size: number; mtime?: number; birthtime?: number },
    { size: number; mimetype: string; sha256: string }
  >;
  teardown(): Promise<void>;
};

async function readAll(registry: BinarySetup['registry'], id: string): Promise<Uint8Array> {
  const handle = await registry.open(id, {}, 'r');
  try {
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await handle.read(64 * 1024);
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  } finally {
    await handle.close();
  }
}

async function writeAll(registry: BinarySetup['registry'], id: string, data: Uint8Array, mode: 'w' | 'a' = 'w'): Promise<void> {
  const handle = await registry.open(id, {}, mode);
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
}

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
  /** The registry's stat reports birthtime and mtime, as file registries do and blob ones do not. */
  times?: boolean;
};

export function binaryConformanceTests(name: string, setup: () => Promise<BinarySetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, teardown } = await setup();
    const enc = new TextEncoder();

    try {
      await t.step('write/read roundtrip is byte-exact', async () => {
        const data = new Uint8Array(64 * 1024 + 17);
        for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;

        await writeAll(registry, 'roundtrip', data);
        const back = await readAll(registry, 'roundtrip');

        assertEquals(back, data);
      });

      await t.step('a multi-megabyte payload streams back byte-exact', async () => {
        const data = new Uint8Array(4 * 1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

        await writeAll(registry, 'big', data);
        assertEquals((await registry.stat('big')).size, data.length);
        assertEquals(await readAll(registry, 'big'), data);

        await registry.delete('big');
      });

      await t.step('exists and stat.size', async () => {
        assertEquals(await registry.exists('roundtrip'), true);
        assertEquals(await registry.exists('missing'), false);

        const stat = await registry.stat('roundtrip');
        assertEquals(stat.size, 64 * 1024 + 17);
      });

      if (opts?.times) {
        await t.step('stat reports created and modified times', async () => {
          // A filesystem stamps times from a clock coarser than Date.now(), so a file created
          // just after `before` may carry a time a little before it.
          const before = Date.now() - 1000;
          await writeAll(registry, 'times', new Uint8Array(0));

          const first = await registry.stat('times');
          assert(first.birthtime! >= before);
          assert(first.mtime! >= first.birthtime!);

          await new Promise((resolve) => setTimeout(resolve, 20));
          const handle = await registry.open('times', {}, 'r+');
          try {
            await handle.write(enc.encode('x'));
          } finally {
            await handle.close();
          }

          const second = await registry.stat('times');
          assertEquals(second.birthtime, first.birthtime);
          assert(second.mtime! > first.mtime!);
        });
      }

      await t.step('statX computes sha256 and mimetype', async () => {
        await writeAll(registry, 'text', enc.encode('hello statx\n'));

        const statX = await registry.statX('text');
        assertEquals(typeof statX.sha256, 'string');
        assertEquals(statX.sha256.length, 64);
        assertEquals(typeof statX.mimetype, 'string');
      });

      await t.step('w mode truncates existing content', async () => {
        await writeAll(registry, 'trunc', enc.encode('first version'));
        await writeAll(registry, 'trunc', enc.encode('2nd'));

        assertEquals(new TextDecoder().decode(await readAll(registry, 'trunc')), '2nd');
      });

      await t.step('a mode appends', async () => {
        await writeAll(registry, 'app', enc.encode('one'));
        await writeAll(registry, 'app', enc.encode('two'), 'a');

        assertEquals(new TextDecoder().decode(await readAll(registry, 'app')), 'onetwo');
      });

      await t.step('a mode writes at the end after a seek', async () => {
        await writeAll(registry, 'app-seek', enc.encode('0123'));

        const handle = await registry.open('app-seek', {}, 'a+');
        try {
          await handle.seek(1, ResourceSeekMode.Start);
          await handle.write(enc.encode('xy'));
        } finally {
          await handle.close();
        }

        assertEquals(new TextDecoder().decode(await readAll(registry, 'app-seek')), '0123xy');
      });

      await t.step('seek then read from offset', async () => {
        await writeAll(registry, 'seek', enc.encode('0123456789'));

        const handle = await registry.open('seek', {}, 'r');
        try {
          await handle.seek(4, ResourceSeekMode.Start);
          const chunk = await handle.read(3);
          assertEquals(new TextDecoder().decode(chunk), '456');
        } finally {
          await handle.close();
        }
      });

      await t.step('open for read of missing resource fails', async () => {
        await assertRejects(() => registry.open('does-not-exist', {}, 'r'));
      });

      await t.step('list and count include created resources', async () => {
        const ids: string[] = [];
        for await (const id of await registry.list()) {
          ids.push(id);
        }

        assertEquals(ids.includes('roundtrip'), true);
        assertEquals(ids.includes('text'), true);
        assertEquals(await registry.count() >= ids.length, true);
      });

      await t.step('delete removes the resource', async () => {
        assertEquals(await registry.delete('roundtrip'), true);
        assertEquals(await registry.exists('roundtrip'), false);
        assertEquals(await registry.delete('roundtrip'), false);
      });
    } finally {
      await teardown();
    }
  });
}
