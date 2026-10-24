/**
 * Shared conformance suite for log registries. Reused by the memory
 * (fast tier) and PostgreSQL/TimescaleDB (PG tier) implementations.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { RouterManagerIf } from '../../../managers/router/mod.ts';
import { ResourceSeekMode } from '../../types.ts';
import { LogHandle } from '../log-handle.ts';
import type { LogRegistryIf } from '../types.ts';
import { waitFor } from '../../test/relay-wait.ts';

export type LogSetup = {
  registry: LogRegistryIf;
  router: RouterManagerIf;
  teardown(): Promise<void>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function parseLines<T>(data: Uint8Array): T[] {
  return dec.decode(data).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
};

export function logConformanceTests(name: string, setup: () => Promise<LogSetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, router, teardown } = await setup();

    try {
      await t.step('touch creates, stat reports retention and routing keys', async () => {
        assertEquals(await registry.touch('log1', { retention: 'forever', routingKeys: ['log.test'] }), true);
        assertEquals(await registry.exists('log1'), true);

        const stat = await registry.stat('log1');
        assertEquals(stat.retention, 'forever');
        assertEquals(stat.routingKeys, ['log.test']);
        assertEquals(stat.size, 0);
      });

      await t.step('append and read entries in order', async () => {
        const writer = await registry.open('log1', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ seq: 1 }) + '\n' + JSON.stringify({ seq: 2 }) + '\n'));
          await writer.write(enc.encode(JSON.stringify({ seq: 3 }) + '\n'));
        } finally {
          await writer.close();
        }

        const reader = await registry.open('log1', {}, 'r');
        try {
          const entries = parseLines<{ seq: number }>(await reader.read(10));
          assertEquals(entries.map((e) => e.seq), [1, 2, 3]);
        } finally {
          await reader.close();
        }
      });

      await t.step('read continues from the cursor', async () => {
        const reader = await registry.open('log1', {}, 'r');
        try {
          const first = parseLines<{ seq: number }>(await reader.read(2));
          assertEquals(first.map((e) => e.seq), [1, 2]);

          const rest = parseLines<{ seq: number }>(await reader.read(10));
          assertEquals(rest.map((e) => e.seq), [3]);
        } finally {
          await reader.close();
        }
      });

      await t.step('append mode seeks to end — only new entries are read', async () => {
        const tail = await registry.open('log1', {}, 'a+');
        const writer = await registry.open('log1', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ seq: 4 }) + '\n'));

          const entries = parseLines<{ seq: number }>(await tail.read(10));
          assertEquals(entries.map((e) => e.seq), [4]);
        } finally {
          await tail.close();
          await writer.close();
        }
      });

      // Seek positions AT an entry; reads return entries AFTER the cursor
      await t.step('seek to start positions at the first entry', async () => {
        const reader = await registry.open('log1', {}, 'r');
        try {
          await reader.read(10);
          await reader.seek(0, ResourceSeekMode.Start);
          const entries = parseLines<{ seq: number }>(await reader.read(10));
          assertEquals(entries.map((e) => e.seq), [2, 3, 4]);
        } finally {
          await reader.close();
        }
      });

      // How `tail -n k` and a log read from its end find their start.
      await t.step('seek back k from the end: the next read is the newest k', async () => {
        const reader = await registry.open('log1', {}, 'r');
        try {
          await reader.seek(-2, ResourceSeekMode.End);
          assertEquals(parseLines<{ seq: number }>(await reader.read(10)).map((e) => e.seq), [3, 4]);
          await reader.seek(-3, ResourceSeekMode.End);
          assertEquals(parseLines<{ seq: number }>(await reader.read(10)).map((e) => e.seq), [2, 3, 4]);
          // As far back as the log is long there is no entry to stand on: the seek fails.
          await assertRejects(() => reader.seek(-4, ResourceSeekMode.End));
        } finally {
          await reader.close();
        }
      });

      await t.step('blocking read resolves on new entry and empties on abort', async () => {
        const tail = await registry.open('log1', {}, 'a+');
        const writer = await registry.open('log1', {}, 'a');
        try {
          const ac = new AbortController();
          const pending = tail.read(10, ac.signal);

          await writer.write(enc.encode(JSON.stringify({ seq: 5 }) + '\n'));
          assertEquals(parseLines<{ seq: number }>(await pending).map((e) => e.seq), [5]);

          const ac2 = new AbortController();
          const pending2 = tail.read(10, ac2.signal);
          ac2.abort();
          assertEquals((await pending2).length, 0);
        } finally {
          await tail.close();
          await writer.close();
        }
      });

      await t.step('count retention keeps only the newest entries', async () => {
        await registry.touch('capped', { retention: '3 entries', routingKeys: [] });

        const writer = await registry.open('capped', {}, 'a');
        try {
          for (let i = 1; i <= 5; i++) {
            await writer.write(enc.encode(JSON.stringify({ i }) + '\n'));
          }
        } finally {
          await writer.close();
        }

        assertEquals((await registry.stat('capped')).size, 3);

        const reader = await registry.open('capped', {}, 'r');
        try {
          const entries = parseLines<{ i: number }>(await reader.read(10));
          assertEquals(entries.map((e) => e.i), [3, 4, 5]);
        } finally {
          await reader.close();
        }
      });

      await t.step('routed events are captured into bound logs', async () => {
        router.publish('log.test', { routed: true });

        // Give the router relay a tick to deliver
        await new Promise((r) => setTimeout(r, 50));

        const reader = await registry.open('log1', {}, 'r');
        try {
          const entries = parseLines<Record<string, unknown>>(await reader.read(100));
          assertEquals(entries.some((e) => e.routed === true), true);
        } finally {
          await reader.close();
        }
      });

      await t.step('a pattern binding captures every key it covers', async () => {
        await registry.touch('patlog', { retention: 'forever', routingKeys: ['system.vfs.*.created'] });

        router.publish('system.vfs.file.created', { n: 1 });
        router.publish('system.vfs.exif.created', { n: 2 });
        router.publish('system.vfs.file.updated', { n: 3 });

        await waitFor(async () => (await registry.stat('patlog')).size >= 2);

        const reader = await registry.open('patlog', {}, 'r');
        try {
          const entries = parseLines<{ n: number }>(await reader.read(100));
          assertEquals(entries.map((e) => e.n).toSorted(), [1, 2]);
        } finally {
          await reader.close();
        }
      });

      // The relay is a fan-in nothing awaits, so a backend may batch its writes to keep up; this
      // is more events than such a batch holds, where per-event and per-batch paths diverge.
      await t.step('a relayed burst is captured whole, in publish order', async () => {
        await registry.touch('burst', { retention: 'forever', routingKeys: ['burst.key'] });

        const total = 1200;
        for (let i = 0; i < total; i++) router.publish('burst.key', { seq: i });

        await waitFor(async () => (await registry.stat('burst')).size >= total, 30_000);

        const reader = await registry.open('burst', {}, 'r') as LogHandle;
        try {
          const entries = await reader.readEntries(total + 10);
          assertEquals(entries.map((e) => (e.data as { seq: number }).seq), Array.from({ length: total }, (_, i) => i));
        } finally {
          await reader.close();
        }
      });

      await t.step('appendAt backdates entries; readEntries surfaces createdAt', async () => {
        await registry.touch('series', { retention: 'forever', routingKeys: [] });

        const t0 = new Date('2018-01-01T00:00:00.000Z');
        const t1 = new Date('2020-06-15T12:00:00.000Z');
        const writer = await registry.open('series', {}, 'a') as LogHandle;
        try {
          await writer.appendAt({ value: 10 }, t0);
          await writer.appendAt({ value: 20 }, t1);
          await writer.appendAt({ value: 30 }); // now
        } finally {
          await writer.close();
        }

        const reader = await registry.open('series', {}, 'r') as LogHandle;
        try {
          const entries = await reader.readEntries(10);
          assertEquals(entries.map((e) => (e.data as { value: number }).value), [10, 20, 30]);
          assertEquals(entries[0].createdAt.getTime(), t0.getTime());
          assertEquals(entries[1].createdAt.getTime(), t1.getTime());
          // third entry stamped ~now
          assertEquals(entries[2].createdAt.getTime() > t1.getTime(), true);
        } finally {
          await reader.close();
        }

        assertEquals(await registry.delete('series'), true);
      });

      await t.step('w mode truncates the log', async () => {
        const truncator = await registry.open('capped', {}, 'w');
        await truncator.close();
        assertEquals((await registry.stat('capped')).size, 0);
      });

      await t.step('delete removes the log', async () => {
        assertEquals(await registry.delete('capped'), true);
        assertEquals(await registry.exists('capped'), false);
        await assertRejects(() => registry.stat('capped'));
      });
    } finally {
      await teardown();
    }
  });
}
