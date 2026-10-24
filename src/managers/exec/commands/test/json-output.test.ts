/**
 * JSON output contract: the API shell runs every command with JSON_OUTPUT=1, so
 * structured/report commands must emit parseable JSON and side-effect commands
 * must emit { ok: true }.
 */

import { assert, assertEquals } from '@std/assert';
import { createTestContext } from '../../../../testing/mod.ts';
import type { PipelineSummary } from '../../../../lib/api/pipeline.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'json output contract',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    await t.step('service-list emits a JSON array of service records', async () => {
      const list = await client.execJson<Array<{ name: string; status: string; enabled: boolean }>>('service-list');
      assert(Array.isArray(list), 'service-list should be an array');
      for (const svc of list) {
        assertEquals(typeof svc.name, 'string');
        assertEquals(typeof svc.enabled, 'boolean');
      }
    });

    await t.step('user-id emits a JSON identity object', async () => {
      const id = await client.execJson<{ uid: number; user: string; gid: number; groups: unknown[] }>('user-id');
      assertEquals(typeof id.uid, 'number');
      assertEquals(id.user, 'admin');
      assert(Array.isArray(id.groups), 'groups should be an array');
    });

    await t.step('detach --list emits a JSON array', async () => {
      const jobs = await client.execJson<unknown[]>('detach --list');
      assert(Array.isArray(jobs), 'detach --list should be an array');
    });

    await t.step('mount emits a JSON array of mount records', async () => {
      const mounts = await client.execJson<Array<{ path: string; type: string }>>('mount');
      assert(Array.isArray(mounts), 'mount should be an array');
      for (const m of mounts) {
        assertEquals(typeof m.path, 'string');
        assertEquals(typeof m.type, 'string');
      }
    });

    await t.step('pipeline-list carries a rendered trigger label', async () => {
      const defs = await client.execJson<Array<{ name: string; triggerLabel?: string; error?: boolean }>>('pipeline-list');
      assert(Array.isArray(defs), 'pipeline-list should be an array');
      for (const def of defs) {
        if (def.error) continue;
        // Fact-triggered definitions have no event/nodeType; triggerLabel is the
        // label to show, and never contains 'undefined'.
        assertEquals(typeof def.triggerLabel, 'string');
        assertEquals(def.triggerLabel!.includes('undefined'), false, `bad label for ${def.name}: ${def.triggerLabel}`);
      }
    });

    await t.step('pipeline-list carries each trigger with its guards', async () => {
      const defs = await client.execJson<PipelineSummary[]>('pipeline-list');
      // The dashboard's trigger card reads the guards from triggerRules, so it must describe
      // the same alternatives as triggers, one for one.
      for (const def of defs) {
        if (def.error) continue;
        assertEquals(def.triggerRules?.length, def.triggers.length, `triggerRules out of step with triggers for ${def.name}`);
      }
    });

    await t.step('pipeline-instances is a page object, not a bare array', async () => {
      const page = await client.execJson<{ items: unknown[]; nextCursor: string | null }>('pipeline-instances');
      assert(Array.isArray(page.items), 'items should be an array');
      assert(page.nextCursor === null || typeof page.nextCursor === 'string');
    });

    await t.step('pipeline-overview emits the dashboard payload', async () => {
      const data = await client.execJson<{
        instances: { total: number; byStatus: Record<string, number> };
        queues: unknown[];
        active: unknown[];
        completions: unknown[];
      }>('pipeline-overview');
      assertEquals(typeof data.instances.total, 'number');
      assertEquals(typeof data.instances.byStatus.running, 'number');
      assert(Array.isArray(data.queues));
      assert(Array.isArray(data.active));
      assert(Array.isArray(data.completions));
    });

    await t.step('side-effect commands emit { ok: true } in JSON mode', async () => {
      await client.exec('mknode -t directory /jsontest');
      assertEquals((await client.execJson<{ ok: boolean }>('chmod 700 /jsontest')).ok, true);
      assertEquals((await client.execJson<{ ok: boolean }>('rm -r /jsontest')).ok, true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
