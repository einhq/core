/**
 * Pipeline engine behavior with stub step commands: trigger filter,
 * skipIf, DAG ordering, condition gating, retries, the step exit codes and derived-node skip.
 *
 * Runs against the full-boot harness where the engine runs as the
 * pipeline-engine service consuming /queues/pipeline-engine.
 */

import { PIPELINE_DEFINITIONS_PATH, PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testpipe';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function markers(client: ShellClient, name: string): Promise<string[]> {
  const result = await client.exec(`cat /tmp/markers/${name}`);
  if (!result.success) return [];
  return String(result.data).trim().split('\n').filter(Boolean);
}

Deno.test({
  name: 'pipeline engine',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  // Instance status helper
  const instanceStatuses = async (pipeline: string): Promise<string[]> => {
    const listing = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${pipeline}`);
    if (!listing.success) return [];
    const ids = listing.data as string[];
    const statuses: string[] = [];
    for (const id of ids) {
      const attrs = await client.execJson<{ status: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/${pipeline}/${id}`);
      statuses.push(attrs.status);
    }
    return statuses;
  };

  try {
    // ---- Fixture: stub step commands + pipeline definitions ----

    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers && mkdir -p /work');

    const scripts: Record<string, string> = {
      'step-first': 'name=$(basename "$1")\necho first >> "/tmp/markers/$name"',
      'step-second': 'name=$(basename "$1")\necho second >> "/tmp/markers/$name"',
      'step-cond': 'name=$(basename "$1")\necho cond >> "/tmp/markers/$name"',
      'step-flaky': 'name=$(basename "$1")\necho try >> "/tmp/markers/$name-flaky"\ncount=$(cat "/tmp/markers/$name-flaky" | wc -l)\n[ "$count" -ge "2" ]',
      // later.bin: the service it needs is away on the first run (75). broken.bin: bytes nothing can open (65).
      'step-exit': [
        'name=$(basename "$1")',
        'echo run >> "/tmp/markers/$name-exit"',
        'count=$(cat "/tmp/markers/$name-exit" | wc -l)',
        'case "$name" in',
        '  later.bin) [ "$count" -ge "2" ] || exit 75;;',
        '  broken.bin) exit 65;;',
        'esac',
      ].join('\n'),
    };

    for (const [name, body] of Object.entries(scripts)) {
      await client.exec(`mkfile /opt/steps/${name} && chmod 755 /opt/steps/${name}`);
      const handle = await vfs.open(ADMIN_ACCESS, `/opt/steps/${name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(body + '\n'));
      } finally {
        await handle.close();
      }
    }

    // Engine re-sources /etc/bashrc when it changes — extend PATH there
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    const pipelineYaml = [
      'name: test-index',
      'description: fixture pipeline',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      `      ${TEST_MIME}) exit 0;;`,
      '      *) exit 1;;',
      '    esac',
      '  skipIf: |',
      `    JSON_OUTPUT=1 attrs $NODE_PATH | jq -e '.sourceId'`,
      '',
      'steps:',
      '  first:',
      '    command: step-first $NODE_PATH',
      '  second:',
      '    command: step-second $NODE_PATH',
      '    dependsOn: [first]',
      '  conditional:',
      '    command: step-cond $NODE_PATH',
      '    dependsOn: [first]',
      `    condition: JSON_OUTPUT=1 attrs $NODE_PATH | jq -e '.runCond'`,
      '',
      'options:',
      '  maxAttempts: 3',
    ].join('\n');

    const retryYaml = [
      'name: test-retry',
      'description: retry fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      '      application/x-testretry) exit 0;;',
      '      *) exit 1;;',
      '    esac',
      '',
      'steps:',
      '  flaky:',
      '    command: step-flaky $NODE_PATH',
      '',
      'options:',
      '  maxAttempts: 3',
    ].join('\n');

    const exitYaml = [
      'name: test-exit',
      'description: exit code fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      '      application/x-testexit) exit 0;;',
      '      *) exit 1;;',
      '    esac',
      '',
      'steps:',
      '  work:',
      '    command: step-exit $NODE_PATH',
      '',
      'options:',
      '  maxAttempts: 3',
    ].join('\n');

    for (
      const [file, content] of [['/work/test-index.yaml', pipelineYaml], ['/work/test-retry.yaml', retryYaml], ['/work/test-exit.yaml', exitYaml]] as const
    ) {
      await client.exec(`mkfile ${file}`);
      const handle = await vfs.open(ADMIN_ACCESS, file, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(content + '\n'));
      } finally {
        await handle.close();
      }
    }

    await t.step('pipeline define registers definitions', async () => {
      assertEquals((await client.exec('pipeline define /work/test-index.yaml')).success, true);
      assertEquals((await client.exec('pipeline define /work/test-retry.yaml')).success, true);

      const defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      assertEquals(defs.includes('test-index'), true);
      assertEquals(defs.includes('test-retry'), true);
    });

    await t.step('setup: a queue bound to the pipeline lifecycle events', async () => {
      assertEquals((await client.exec('mknode -t queue --al "routingKeys=system.pipeline" /work/lifecycle')).success, true);
    });

    await t.step('matching update triggers the pipeline and DAG runs in order', async () => {
      await client.exec(`mknode -t file --as "name=photo.bin" --as "mimetype=${TEST_MIME}" /work/photo.bin`);
      // The created event does not trigger (event: updated); this chmod does
      await client.exec('chmod 644 /work/photo.bin');

      await waitFor(async () => {
        const m = await markers(client, 'photo.bin');
        return m.includes('first') && m.includes('second');
      }, 'photo.bin steps to run');

      const m = await markers(client, 'photo.bin');
      assertEquals(m.indexOf('first') < m.indexOf('second'), true, `order was ${m}`);

      await waitFor(async () => (await instanceStatuses('test-index')).includes('completed'), 'instance completion');
    });

    await t.step('a run reports its start, each step, and its end on /dev/pipeline-events', async () => {
      type Peeked = { items: { data: { type: string; subject: string; data: { pipeline: string; step?: string } } }[] };
      const events = async () =>
        (await client.execJson<Peeked>('queue-peek -n 100 /work/lifecycle')).items.map((item) => item.data)
          .filter((event) => event.subject === '/work/photo.bin');

      await waitFor(async () => (await events()).some((event) => event.type === 'pipeline.instance.completed'), 'the completed event');

      const seen = (await events()).map((event) => event.data.step ? `${event.type} ${event.data.step}` : event.type);
      assertEquals(seen[0], 'pipeline.instance.started');
      assertEquals(seen.at(-1), 'pipeline.instance.completed');
      for (const expected of ['pipeline.step.started first', 'pipeline.step.completed first', 'pipeline.step.completed second', 'pipeline.step.skipped conditional']) {
        assertEquals(seen.includes(expected), true, `${expected} missing from ${seen}`);
      }
      assertEquals(seen.indexOf('pipeline.step.completed first') < seen.indexOf('pipeline.step.started second'), true, `order was ${seen}`);
      assertEquals((await events()).every((event) => event.data.pipeline === 'test-index'), true);
    });

    // `pipeline start` creates an instance directly instead of going through a
    // trigger. createInstanceFromDef writes the instance, `steps/` and the steps
    // as one transaction, so the instance's own created event is delivered with
    // the steps already in place and the advance it schedules sees the real DAG.
    await t.step('pipeline start advances a manually created instance', async () => {
      // event: updated, so creating the node does not trigger the pipeline — only the
      // explicit `pipeline start` below can be what runs it.
      await client.exec(`mknode -t file --as "name=manual.bin" --as "mimetype=${TEST_MIME}" /work/manual.bin`);
      assertEquals((await client.exec('pipeline start test-index /work/manual.bin')).success, true);

      await waitFor(async () => {
        const m = await markers(client, 'manual.bin');
        return m.includes('first') && m.includes('second');
      }, 'manually started instance to run its steps');
    });

    await t.step('condition-gated step is skipped without the attr', async () => {
      const m = await markers(client, 'photo.bin');
      assertEquals(m.includes('cond'), false);
    });

    await t.step('condition-gated step runs when the attr is set', async () => {
      await client.exec(`mknode -t file --as "name=condy.bin" --as "mimetype=${TEST_MIME}" --aj "runCond=true" /work/condy.bin`);
      await client.exec('chmod 644 /work/condy.bin');

      await waitFor(async () => (await markers(client, 'condy.bin')).includes('cond'), 'conditional step');
    });

    await t.step('non-matching mimetype does not trigger', async () => {
      await client.exec('mkfile /work/plain.txt && echo "plain" > /work/plain.txt');
      await client.exec('chmod 644 /work/plain.txt');

      // Give the engine a moment, then confirm nothing ran
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await markers(client, 'plain.txt'), []);
    });

    await t.step('rendition nodes (with sourceId) are skipped', async () => {
      await client.exec(
        `mknode -t file --as "name=rendition.bin" --as "mimetype=${TEST_MIME}" --as "sourceId=00000000000000000000000000" /work/rendition.bin`,
      );
      await client.exec('chmod 644 /work/rendition.bin');

      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await markers(client, 'rendition.bin'), []);
    });

    await t.step('re-triggering right after completion is suppressed (self-inflicted guard)', async () => {
      const instancesForPhoto = async (): Promise<string[]> => {
        const listing = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-index`);
        if (!listing.success) return [];
        const ids = listing.data as string[];
        const hits: string[] = [];
        for (const id of ids) {
          try {
            const a = await client.execJson<{ triggerPath: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-index/${id}`);
            if (a.triggerPath === '/work/photo.bin') hits.push(id);
          } catch {
            // instance vanished mid-scan — ignore
          }
        }
        return hits;
      };

      const before = await instancesForPhoto();
      assertEquals(before.length, 1, `one instance for photo.bin before, got ${before}`);

      // A re-trigger within the self-inflicted window (the instance just completed,
      // well inside SELF_TRIGGER_GRACE_MS) is treated as a pipeline's own write and
      // suppressed — the engine does not know or care what nodes the pipeline
      // touched. So no new instance is created and the id is unchanged.
      await client.exec('chmod 644 /work/photo.bin');
      await new Promise((r) => setTimeout(r, 1000));
      const after = await instancesForPhoto();
      assertEquals(after.length, 1, `still one instance, got ${after}`);
      assertEquals(after[0], before[0], 'instance not replaced (trigger suppressed)');
    });

    await t.step('failing step is retried until it succeeds', async () => {
      await client.exec('mknode -t file --as "name=flaky.bin" --as "mimetype=application/x-testretry" /work/flaky.bin');
      await client.exec('chmod 644 /work/flaky.bin');

      await waitFor(async () => (await markers(client, 'flaky.bin-flaky')).length >= 2, 'retry attempts');
      await waitFor(async () => (await instanceStatuses('test-retry')).includes('completed'), 'retry instance completion');

      // Exactly two attempts: first failed, second succeeded
      assertEquals((await markers(client, 'flaky.bin-flaky')).length, 2);
    });

    await t.step('a step that could not run yet waits without spending a run, then runs', async () => {
      assertEquals((await client.exec('pipeline define /work/test-exit.yaml')).success, true);
      await client.exec('mknode -t file --as "name=later.bin" --as "mimetype=application/x-testexit" /work/later.bin');
      await client.exec('chmod 644 /work/later.bin');

      const dir = `${PIPELINE_INSTANCES_PATH}/test-exit`;
      let stepPath = '';
      await waitFor(async () => {
        const ids = (await client.exec(`ls ${dir}`)).data as string[] | undefined;
        if (!ids?.length) return false;
        stepPath = `${dir}/${ids[0]}/steps/work`;
        return (await client.execJson<{ notBefore?: number }>(`attrs ${stepPath}`)).notBefore !== undefined;
      }, 'the step to be handed back');

      const waiting = await client.execJson<{ status: string; attempts: number; notBefore: number }>(`attrs ${stepPath}`);
      assertEquals([waiting.status, waiting.attempts], ['pending', 0]);
      assertEquals(waiting.notBefore > Date.now() + 60_000, true, 'waits minutes, not a moment');
      await new Promise((r) => setTimeout(r, 500));
      assertEquals((await markers(client, 'later.bin-exit')).length, 1, 'not run again before its time');

      // Its time comes.
      await vfs.update(ADMIN_ACCESS, stepPath, { attrs: { notBefore: Date.now() - 1 } });
      await waitFor(async () => (await instanceStatuses('test-exit')).includes('completed'), 'the instance to complete');
      const done = await client.execJson<{ attempts: number; notBefore?: number }>(`attrs ${stepPath}`);
      assertEquals([done.attempts, done.notBefore], [1, undefined]);
    });

    await t.step('a step whose input cannot be processed fails at once, not retried', async () => {
      await client.exec('mknode -t file --as "name=broken.bin" --as "mimetype=application/x-testexit" /work/broken.bin');
      await client.exec('chmod 644 /work/broken.bin');

      await waitFor(async () => (await instanceStatuses('test-exit')).includes('failed'), 'the instance to fail');
      assertEquals((await markers(client, 'broken.bin-exit')).length, 1);
      const ids = (await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-exit`)).data as string[];
      const steps = await Promise.all(ids.map((id) => client.execJson<{ status: string; cause?: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-exit/${id}/steps/work`)));
      assertEquals(steps.find((s) => s.status === 'failed')?.cause, 'input');
    });

    // ---- Domain event triggers ----

    await t.step('a pipeline triggers on a domain event written to /dev/events', async () => {
      const eventYaml = [
        'name: test-event',
        'description: domain event fixture',
        '',
        'trigger:',
        '  on: test.thing.happened',
        '  filter: |',
        '    case "$EVENT_MIMETYPE" in',
        `      ${TEST_MIME}) exit 0;;`,
        '      *) exit 1;;',
        '    esac',
        '',
        'steps:',
        '  first:',
        '    command: step-first $NODE_PATH',
        '  echo-event:',
        '    command: step-event $NODE_PATH $EVENT_LABEL',
        '    dependsOn: [first]',
      ].join('\n');

      await client.exec('mkfile /opt/steps/step-event && chmod 755 /opt/steps/step-event');
      const stepHandle = await vfs.open(ADMIN_ACCESS, '/opt/steps/step-event', { mode: 'w' });
      try {
        await stepHandle.write(new TextEncoder().encode('name=$(basename "$1")\necho "$2" >> "/tmp/markers/$name"\n'));
      } finally {
        await stepHandle.close();
      }

      await client.exec('mkfile /work/test-event.yaml');
      const yamlHandle = await vfs.open(ADMIN_ACCESS, '/work/test-event.yaml', { mode: 'w' });
      try {
        await yamlHandle.write(new TextEncoder().encode(eventYaml + '\n'));
      } finally {
        await yamlHandle.close();
      }

      assertEquals((await client.exec('pipeline define /work/test-event.yaml')).success, true);
      await waitFor(
        async () => (await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`)).includes('test-event'),
        'test-event definition registered',
      );

      await client.exec(`mknode -t file --as "name=evented.bin" --as "mimetype=${TEST_MIME}" /work/evented.bin`);

      // A publisher is anything that can write a line to the router node
      const event = {
        id: '01JTESTEVENT',
        type: 'test.thing.happened',
        subject: '/work/evented.bin',
        time: Date.now(),
        source: 'engine-test',
        data: { mimetype: TEST_MIME, label: 'from-event' },
      };
      await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);

      await waitFor(async () => {
        const m = await markers(client, 'evented.bin');
        return m.includes('first') && m.includes('from-event');
      }, 'domain-triggered steps to run');

      // $EVENT_* reached the step command, not just the trigger filter
      assertEquals((await markers(client, 'evented.bin')).includes('from-event'), true);
      await waitFor(async () => (await instanceStatuses('test-event')).includes('completed'), 'event instance completion');
    });

    await t.step('multiple triggers keep their own guards, vars and priority', async () => {
      const yaml = [
        'name: test-multi-trigger',
        'vars:',
        '  MODE: normal',
        'triggers:',
        '  - on: test.media.ready',
        '    skipIfExists: $NODE_PATH/result',
        '  - on: test.media.stale',
        '    vars:',
        '      MODE: forced',
        '    priority: 10',
        'steps:',
        '  record:',
        '    command: step-event $NODE_PATH $MODE',
        'options:',
        '  priority: 50',
      ].join('\n');

      await client.exec('mkfile /work/test-multi-trigger.yaml');
      const yamlHandle = await vfs.open(ADMIN_ACCESS, '/work/test-multi-trigger.yaml', { mode: 'w' });
      try {
        await yamlHandle.write(new TextEncoder().encode(yaml + '\n'));
      } finally {
        await yamlHandle.close();
      }
      assertEquals((await client.exec('pipeline define /work/test-multi-trigger.yaml')).success, true);

      const emit = async (type: string, subject: string, id: string) => {
        const event = { id, type, subject, time: Date.now(), source: 'engine-test', data: {} };
        await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
      };
      const attrsFor = async (subject: string): Promise<{ priority?: number; vars?: Record<string, string> }> => {
        const node = await vfs.get(ADMIN_ACCESS, subject);
        return await client.execJson(
          `attrs ${PIPELINE_INSTANCES_PATH}/test-multi-trigger/${node.id}`,
        );
      };

      await client.exec('mknode -t file --as "name=guarded.bin" /work/guarded.bin');
      await client.exec('mkdir /work/guarded.bin/result');
      await emit('test.media.ready', '/work/guarded.bin', '01JTESTMULTINORMALSKIP');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals(await markers(client, 'guarded.bin'), [], 'ordinary trigger obeys skipIfExists');

      await emit('test.media.stale', '/work/guarded.bin', '01JTESTMULTISTALE');
      await waitFor(async () => (await markers(client, 'guarded.bin')).includes('forced'), 'stale trigger to run');
      const staleAttrs = await attrsFor('/work/guarded.bin');
      assertEquals(staleAttrs.priority, 10);
      assertEquals(staleAttrs.vars, { MODE: 'forced' });

      const guardedNode = await vfs.get(ADMIN_ACCESS, '/work/guarded.bin');
      const forcedBefore = (await markers(client, 'guarded.bin')).filter((line) => line === 'forced').length;
      await client.exec(`pipeline rerun test-multi-trigger/${guardedNode.id}`);
      await waitFor(
        async () => (await markers(client, 'guarded.bin')).filter((line) => line === 'forced').length > forcedBefore,
        'rerun to retain trigger vars',
      );
      const rerunAttrs = await attrsFor('/work/guarded.bin');
      assertEquals(rerunAttrs.priority, 10);
      assertEquals(rerunAttrs.vars, { MODE: 'forced' });

      await client.exec('mknode -t file --as "name=fresh.bin" /work/fresh.bin');
      await emit('test.media.ready', '/work/fresh.bin', '01JTESTMULTIFRESH');
      await waitFor(async () => (await markers(client, 'fresh.bin')).includes('normal'), 'ordinary trigger to run');
      const freshAttrs = await attrsFor('/work/fresh.bin');
      assertEquals(freshAttrs.priority, 50);
      assertEquals(freshAttrs.vars, { MODE: 'normal' });
    });

    // The fact that started an instance is gone by the time anyone reruns it, so
    // the instance has to carry it, or every `$EVENT_*` in a rerun would
    // substitute to nothing.
    await t.step('rerun keeps the event variables the steps were written against', async () => {
      const label = (): Promise<number> => markers(client, 'evented.bin').then((m) => m.filter((line) => line === 'from-event').length);
      const before = await label();

      const ids = await client.execJson<string[]>(`ls ${PIPELINE_INSTANCES_PATH}/test-event`);
      assertEquals(ids.length, 1, `one test-event instance, got ${ids}`);
      const rerun = await client.execJson<{ ids: string[]; missingEventVars?: string[] }>(`pipeline rerun test-event/${ids[0]}`);
      assertEquals(rerun.ids, ids, 'rerun keeps the node-derived id');
      // Nothing is missing: the stored event supplies every name the steps read.
      assertEquals(rerun.missingEventVars, undefined);

      await waitFor(async () => (await label()) > before, 'the rerun step to see $EVENT_LABEL again');
      await waitFor(async () => (await instanceStatuses('test-event')).includes('completed'), 'rerun instance completion');
    });

    await t.step('a domain event whose filter does not match starts nothing', async () => {
      await client.exec(`mknode -t file --as "name=nomatch.bin" --as "mimetype=${TEST_MIME}" /work/nomatch.bin`);

      const event = {
        id: '01JTESTEVENT2',
        type: 'test.thing.happened',
        subject: '/work/nomatch.bin',
        time: Date.now(),
        data: { mimetype: 'application/x-other', label: 'nope' },
      };
      await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);

      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await markers(client, 'nomatch.bin'), []);
    });

    await t.step('an unknown event type is ignored', async () => {
      const event = {
        id: '01JTESTEVENT3',
        type: 'test.nobody.listens',
        subject: '/work/evented.bin',
        time: Date.now(),
        data: {},
      };
      assertEquals((await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`)).success, true);

      // The engine must stay healthy — a following event still triggers
      await new Promise((r) => setTimeout(r, 300));
      assertEquals((await client.exec(`ls ${PIPELINE_DEFINITIONS_PATH}`)).success, true);
    });

    // An advance that finds the steps dir empty treats the instance as unbuilt,
    // not finished, so steps that appear afterwards are still dispatched. The
    // steps dir is left empty on purpose.
    await t.step('an instance with no steps yet is not declared complete', async () => {
      const dir = `${PIPELINE_INSTANCES_PATH}/test-index`;
      // The subject has to exist: the engine drops an instance whose node is
      // gone, and a real half-built instance always has one (it is created from
      // the node's own id). `event: updated` means creating it triggers nothing.
      await client.exec(`mknode -t file --as "name=halfbuilt.bin" --as "mimetype=application/x-other" /work/halfbuilt.bin`);
      await client.exec(
        `mknode -t directory --as 'pipelineName=test-index' --as 'triggerPath=/work/halfbuilt.bin' --as 'status=running' --an 'startedAt=${Date.now()}' ${dir}/halfbuilt`,
      );
      await client.exec(`mknode -t directory ${dir}/halfbuilt/steps`);

      await new Promise((r) => setTimeout(r, 500));

      const attrs = await client.execJson<{ status: string }>(`attrs ${dir}/halfbuilt`);
      assertEquals(attrs.status, 'running');
    });

    await t.step('the instance advances once its steps show up', async () => {
      const dir = `${PIPELINE_INSTANCES_PATH}/test-index`;
      await client.exec(
        `mknode -t directory --as 'stepName=first' --as 'status=pending' --aj 'dependsOn=[]' --as 'command=step-first /work/halfbuilt.bin' ${dir}/halfbuilt/steps/first`,
      );

      await waitFor(async () => {
        const attrs = await client.execJson<{ status: string }>(`attrs ${dir}/halfbuilt`);
        return attrs.status === 'completed';
      }, 'half-built instance to complete once stepped');

      assertEquals(await markers(client, 'halfbuilt.bin'), ['first']);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
