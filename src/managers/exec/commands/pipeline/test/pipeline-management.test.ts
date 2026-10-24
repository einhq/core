/**
 * pipeline-rerun / -remove / -prune command behavior and the one-per-node
 * invariant. Drives instances via `pipeline start` (filter set to never
 * auto-trigger) so the tests fully control instance lifecycle.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../../lib/paths.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'pipeline management',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const listInstances = async (name: string): Promise<string[]> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${name}`);
    if (!res.success) return [];
    return res.data as string[];
  };

  const statusOf = async (name: string, id: string): Promise<string> => {
    const attrs = await client.execJson<{ status: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/${name}/${id}`);
    return attrs.status;
  };

  const startFor = async (name: string, path: string): Promise<string> => {
    const res = await client.execJson<{ ok: boolean; id: string }>(`pipeline start ${name} ${path}`);
    assertEquals(res.ok, true, `start failed: ${JSON.stringify(res)}`);
    return res.id;
  };

  try {
    // A definition whose filter never matches (exit 1), so nothing triggers on its
    // own and every instance is driven via `pipeline start`. Single fast step.
    const yaml = [
      'name: mgmt',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    exit 1',
      'steps:',
      '  only:',
      '    command: echo done',
    ].join('\n');

    const writeYaml = async (path: string, body: string): Promise<void> => {
      await client.exec(`mkfile ${path}`);
      const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(body + '\n'));
      } finally {
        await handle.close();
      }
    };

    await writeYaml('/work/mgmt.yaml', yaml);
    assertEquals((await client.exec('pipeline define /work/mgmt.yaml')).success, true);

    // An instance is named after its trigger node, so the node has to exist.
    for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) {
      await client.exec(`mknode -t file --as "name=${name}" --as "mimetype=application/x-mgmt" /work/${name}`);
    }

    const nodeIdOf = async (path: string): Promise<string> => {
      const info = await client.execJson<{ id: string }>(`info ${path}`);
      return info.id;
    };

    await t.step('start twice for the same path keeps one instance (one-per-node)', async () => {
      const id1 = await startFor('mgmt', '/work/a.bin');
      await waitFor(async () => (await statusOf('mgmt', id1)) === 'completed', 'first instance completes');

      const id2 = await startFor('mgmt', '/work/a.bin');
      const ids = await listInstances('mgmt');
      assertEquals(ids.length, 1, `expected 1 instance, got ${ids}`);
      // The id is the trigger node's, so a restart reuses it rather than
      // accumulating a new one — one-per-node is structural, not swept up after.
      assertEquals(id2, id1);
      assertEquals(ids[0], id1);
      assertEquals(id1, await nodeIdOf('/work/a.bin'));
    });

    await t.step('different paths keep separate instances', async () => {
      await startFor('mgmt', '/work/b.bin');
      const ids = await listInstances('mgmt');
      assertEquals(ids.length, 2, `expected 2 instances, got ${ids}`);
    });

    await t.step('rerun replaces the instance in place', async () => {
      const aId = await nodeIdOf('/work/a.bin');
      const before = await listInstances('mgmt');
      assertEquals(before.includes(aId), true, 'instance for a.bin exists');

      const startedBefore = await client.execJson<{ startedAt: number }>(`attrs ${PIPELINE_INSTANCES_PATH}/mgmt/${aId}`);

      const res = await client.execJson<{ ids: string[] }>(`pipeline rerun ${aId}`);
      assertEquals(res.ids[0], aId, 'rerun keeps the node-derived id');

      const after = await listInstances('mgmt');
      assertEquals(after.length, 2, `still 2 instances, got ${after}`);
      assertEquals(after.includes(aId), true, 'instance still present');

      await waitFor(async () => {
        const attrs = await client.execJson<{ startedAt: number }>(`attrs ${PIPELINE_INSTANCES_PATH}/mgmt/${aId}`);
        return attrs.startedAt > startedBefore.startedAt;
      }, 'rerun produced a fresh run');
    });

    await t.step('a bare id shared by two pipelines is rejected, not guessed', async () => {
      // Instances are named after their trigger node, so one file processed by
      // several pipelines yields several instances with the same id. A bare id is
      // then an error naming the pipelines, not whichever pipeline sorts first.
      const yaml2 = [
        'name: mgmt2',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  filter: |',
        '    exit 1',
        'steps:',
        '  only:',
        '    command: echo done',
      ].join('\n');

      await client.exec('mkfile /work/mgmt2.yaml');
      const h = await vfs.open(ADMIN_ACCESS, '/work/mgmt2.yaml', { mode: 'w' });
      try {
        await h.write(new TextEncoder().encode(yaml2 + '\n'));
      } finally {
        await h.close();
      }
      assertEquals((await client.exec('pipeline define /work/mgmt2.yaml')).success, true);

      const shared = await nodeIdOf('/work/b.bin');
      await startFor('mgmt2', '/work/b.bin');

      const bare = await client.exec(`pipeline status ${shared}`);
      assertEquals(bare.success, false, 'a bare ambiguous id must not resolve');
      assertStringIncludes(String(bare.error), 'exists in 2 pipelines');

      // Qualifying it resolves to exactly the intended instance
      const qualified = await client.execJson<{ pipelineName: string }>(`pipeline status mgmt2/${shared}`);
      assertEquals(qualified.pipelineName, 'mgmt2');
    });

    await t.step('remove deletes an instance', async () => {
      const ids = await listInstances('mgmt');
      const victim = ids[0];
      // Qualified: b.bin's id now exists under mgmt2 as well
      const res = await client.exec(`pipeline remove mgmt/${victim}`);
      assertEquals(res.success, true);
      const after = await listInstances('mgmt');
      assertEquals(after.includes(victim), false, 'removed id gone');
      assertEquals(after.length, ids.length - 1);
    });

    await t.step('prune removes terminal instances', async () => {
      // Ensure at least one instance exists and is completed.
      const id = await startFor('mgmt', '/work/c.bin');
      await waitFor(async () => (await statusOf('mgmt', id)) === 'completed', 'c completes');

      const res = await client.exec('pipeline prune mgmt');
      assertEquals(res.success, true);
      const after = await listInstances('mgmt');
      assertEquals(after.length, 0, `all terminal pruned, got ${after}`);
    });

    await t.step('prune -s keeps other statuses', async () => {
      const id = await startFor('mgmt', '/work/d.bin');
      await waitFor(async () => (await statusOf('mgmt', id)) === 'completed', 'd completes');

      // No failed instances → pruning by failed removes nothing.
      const res = await client.exec('pipeline prune mgmt -s failed');
      assertEquals(res.success, true);
      assertEquals((await listInstances('mgmt')).length, 1, 'completed instance survived');

      // Cleanup.
      await client.exec('pipeline prune mgmt');
    });

    await t.step('pipeline-instances pages with a keyset cursor', async () => {
      type Page = { items: { id: string; pipeline: string }[]; nextCursor: string | null };

      const expected: string[] = [];
      for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) {
        expected.push(await startFor('mgmt', `/work/${name}`));
      }

      const all = await client.execJson<Page>('pipeline-instances mgmt --limit 100');
      assertEquals(all.items.length, expected.length, `expected ${expected.length} instances, got ${all.items.length}`);
      assertEquals(all.nextCursor, null, 'a short page carries no cursor');

      // Walk the same set one row at a time: the union must match the single
      // page exactly, with no duplicates and no gaps.
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: Page = await client.execJson<Page>(`pipeline-instances mgmt --limit 1${cursor ? ` --after ${cursor}` : ''}`);
        if (page.items.length === 0) break;
        paged.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      assertEquals(paged, all.items.map((i) => i.id), 'paged walk matches the single page');
      assertEquals(new Set(paged).size, paged.length, 'no duplicates across pages');
      assertEquals([...paged].sort(), [...expected].sort(), 'every instance appeared exactly once');
    });

    // The retention form — what a scheduler can run unattended.
    await t.step('prune --keep bounds a directory, newest survive', async () => {
      await client.exec('pipeline prune mgmt');

      const order: string[] = [];
      for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) {
        const id = await startFor('mgmt', `/work/${name}`);
        await waitFor(async () => (await statusOf('mgmt', id)) === 'completed', `${name} completes`);
        order.push(id);
      }

      const res = await client.execJson<{ removed: number }>('pipeline prune mgmt --keep 2');
      assertEquals(res.removed, 2);

      const after = await listInstances('mgmt');
      assertEquals(after.length, 2);
      // Completion order is start order here, so the last two are the keepers
      assertEquals(after.toSorted(), order.slice(2).toSorted(), 'the two newest survived');

      // Under the cap: nothing to do, and it must not error on a short directory
      const again = await client.execJson<{ removed: number }>('pipeline prune mgmt --keep 10');
      assertEquals(again.removed, 0);
      assertEquals((await listInstances('mgmt')).length, 2);
    });

    await t.step('prune --keep never touches running instances', async () => {
      await client.exec('pipeline prune mgmt --all');

      // A pipeline whose only step blocks, so the instance stays running.
      await writeYaml(
        '/work/stuck.yaml',
        ['name: stuck', 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  wait:', '    command: sleep 30'].join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/stuck.yaml')).success, true);

      const running = await startFor('stuck', '/work/a.bin');
      await waitFor(async () => (await statusOf('stuck', running)) === 'running', 'instance is running');

      // keep 0 would remove everything terminal; a running instance has no
      // completedAt, so retention cannot see it at all.
      const res = await client.execJson<{ removed: number }>('pipeline prune stuck --keep 0');
      assertEquals(res.removed, 0);
      assertEquals(await statusOf('stuck', running), 'running');

      await client.exec('pipeline prune stuck --all');
    });

    await t.step('prune --max bounds one invocation', async () => {
      await client.exec('pipeline prune mgmt --all');

      for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) {
        const id = await startFor('mgmt', `/work/${name}`);
        await waitFor(async () => (await statusOf('mgmt', id)) === 'completed', `${name} completes`);
      }

      const first = await client.execJson<{ removed: number }>('pipeline prune mgmt --keep 1 --max 2');
      assertEquals(first.removed, 2);
      assertEquals((await listInstances('mgmt')).length, 2);

      // A second cycle finishes the job
      const second = await client.execJson<{ removed: number }>('pipeline prune mgmt --keep 1 --max 2');
      assertEquals(second.removed, 1);
      assertEquals((await listInstances('mgmt')).length, 1);
    });

    // What the pipeline-pruner runs: every pipeline, each to its own cap and
    // --max, inside a wall-time budget.
    await t.step('prune --budget sweeps every pipeline, and an expired one starts nothing', async () => {
      await client.exec('pipeline prune mgmt --all');
      await writeYaml(
        '/work/turns.yaml',
        ['name: turns', 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  only:', '    command: echo done'].join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/turns.yaml')).success, true);

      for (const pipeline of ['mgmt', 'turns']) {
        for (const name of ['a.bin', 'b.bin', 'c.bin']) {
          const id = await startFor(pipeline, `/work/${name}`);
          await waitFor(async () => (await statusOf(pipeline, id)) === 'completed', `${pipeline} ${name} completes`);
        }
      }

      const expired = await client.execJson<{ removed: number }>('pipeline prune --keep 1 --budget 0ms');
      assertEquals(expired.removed, 0);
      assertEquals([(await listInstances('mgmt')).length, (await listInstances('turns')).length], [3, 3]);

      await client.execJson<{ removed: number }>('pipeline prune --keep 1 --max 1 --budget 10m');
      assertEquals([(await listInstances('mgmt')).length, (await listInstances('turns')).length], [2, 2], '--max still holds per pipeline');

      await client.execJson<{ removed: number }>('pipeline prune --keep 1 --budget 10m');
      assertEquals([(await listInstances('mgmt')).length, (await listInstances('turns')).length], [1, 1]);
    });

    // A per-instance variable is what lets one file be treated differently from
    // the crawl — `--var FORCE=-f` re-encodes a video that already has a
    // rendition without the definition forcing every file.
    await t.step('--var overrides a declared variable for one run', async () => {
      await writeYaml(
        '/work/vars.yaml',
        [
          'name: vars',
          'trigger:',
          '  event: updated',
          '  nodeType: file',
          '  filter: |',
          '    exit 1',
          'vars:',
          "  FLAG: ''",
          'steps:',
          '  only:',
          '    command: echo run $FLAG > /work/vars-out',
        ].join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/vars.yaml')).success, true);

      const ran = async (): Promise<string> => {
        await waitFor(async () => (await client.exec('cat /work/vars-out')).success, 'step wrote its output');
        return String((await client.exec('cat /work/vars-out')).data).trim();
      };

      // Unset: the default is empty, and an empty value must vanish rather than
      // become an empty argument.
      const plain = await startFor('vars', '/work/a.bin');
      assertEquals(await ran(), 'run');
      assertEquals((await client.execJson<{ vars: Record<string, string> }>(`pipeline status vars/${plain}`)).vars, { FLAG: '' });

      await client.exec('rm /work/vars-out');

      const forced = await client.execJson<{ ok: boolean; id: string }>('pipeline start vars /work/a.bin --var FLAG=-x');
      assertEquals(forced.ok, true);
      assertEquals(await ran(), 'run -x');
      // Recorded on the instance, so a rerun keeps it and `pipeline status` can
      // say why this run behaved differently.
      assertEquals((await client.execJson<{ vars: Record<string, string> }>(`pipeline status vars/${forced.id}`)).vars, { FLAG: '-x' });

      await client.exec('rm /work/vars-out');
      assertEquals((await client.exec(`pipeline rerun vars/${forced.id}`)).success, true);
      assertEquals(await ran(), 'run -x');
    });

    // A hand-started run has no domain event behind it, so a step reading
    // `$EVENT_*` gets an empty word where its argument should be. Saying so at
    // start time is the difference between "this cannot work" and an instance
    // that fails seconds later as though the work had been attempted.
    await t.step('starting a pipeline that reads $EVENT_* reports what it cannot supply', async () => {
      await writeYaml(
        '/work/evented.yaml',
        [
          'name: evented',
          'trigger:',
          '  on: mgmt.thing.happened',
          'steps:',
          '  only:',
          '    command: echo $EVENT_FILE_PATH $EVENT_LABEL',
        ].join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/evented.yaml')).success, true);

      const res = await client.execJson<{ ok: boolean; missingEventVars?: string[] }>('pipeline start evented /work/c.bin');
      assertEquals(res.ok, true, 'the run still starts — an empty event var may be optional');
      assertEquals(res.missingEventVars, ['EVENT_FILE_PATH', 'EVENT_LABEL']);

      // A pipeline reading none says nothing, so the field stays a signal.
      const quiet = await client.execJson<{ missingEventVars?: string[] }>('pipeline start mgmt /work/d.bin');
      assertEquals(quiet.missingEventVars, undefined);
    });

    await t.step('an undeclared --var is rejected, not ignored', async () => {
      const res = await client.exec('pipeline start vars /work/b.bin --var NOPE=1');
      assertEquals(res.success, false);
      assertStringIncludes(String(res.error), "declares no variable 'NOPE'");

      const bad = await client.exec('pipeline start vars /work/b.bin --var FLAG');
      assertEquals(bad.success, false);
      assertStringIncludes(String(bad.error), 'NAME=VALUE');
    });

    await t.step('prune rejects a non-numeric --keep', async () => {
      const res = await client.exec('pipeline prune mgmt --keep soon');
      assertEquals(res.success, false);
      assertStringIncludes(String(res.error), 'invalid --keep');
    });

    await t.step('prune rejects a --budget that is not a duration', async () => {
      const res = await client.exec('pipeline prune mgmt --keep 1 --budget soon');
      assertEquals(res.success, false);
      assertStringIncludes(String(res.error), 'invalid --budget');
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
