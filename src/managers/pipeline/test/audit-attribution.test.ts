/**
 * A pipeline run's writes say where they came from: each records the run as its `sid` and the
 * write that set the run off as its `cause` — the write behind a VFS trigger, or the one a domain
 * fact was derived from — whether the step runs inline on the engine's shell or on a pool worker,
 * and however deep in a script the writing command or redirection sits. What a run creates is
 * recorded as created by whoever created the node it ran for.
 *
 * Runs against the full-boot harness (engine and worker run as services).
 */

import { EVENTS_NODE_PATH, PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { serializeEvent } from '../../../lib/events/mod.ts';
import { assertEquals, assertExists } from '@std/assert';
import { ADMIN_ACCESS, ADMIN_UID } from '../../../lib/access/mod.ts';
import { SystemTestHarness, testCommands } from '../../../testing/mod.ts';
import type { AuditEntry } from '../../../lib/api/audit.ts';
import type { PipelineInstanceAttrs } from '../types.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testattribution';
const PERSON_UID = 2000;

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'pipeline writes record their run and the write that started it',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  const writeFile = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const created = async (path: string) => (await vfs.audit(ADMIN_ACCESS, { pathPrefix: path, op: 'create' })).find((r) => r.path === path);

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work && mkdir -p /opt/attrpool-worker');

    // A script, so the writes happen in a command the step's command runs, not in the step itself.
    await client.exec('mkfile /opt/steps/derive-inline && chmod 755 /opt/steps/derive-inline');
    await writeFile('/opt/steps/derive-inline', 'mkdir "$1.inline"\necho derived > "$1.redirect"');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await client.exec('mkfile /opt/attrpool-worker/start.sh && chmod 755 /opt/attrpool-worker/start.sh');
    await writeFile('/opt/attrpool-worker/start.sh', `pipeline-worker --pool ${POOLS_PATH}/attrpool --concurrency 1`);

    await client.exec('mkfile /work/test-attribution.yaml');
    await writeFile(
      '/work/test-attribution.yaml',
      [
        'name: test-attribution',
        'description: audit attribution fixture',
        '',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        '',
        'steps:',
        '  inline:',
        '    command: derive-inline $NODE_PATH',
        '  pooled:',
        '    command: mkdir $NODE_PATH.pooled',
        '    pool: attrpool',
      ].join('\n'),
    );
    await cmd.shouldSucceed('pipeline define /work/test-attribution.yaml');

    await client.exec('mkfile /work/test-attribution-fact.yaml');
    await writeFile(
      '/work/test-attribution-fact.yaml',
      [
        'name: test-attribution-fact',
        'description: audit attribution fixture, started by a fact',
        '',
        'trigger:',
        '  on: test.attribution.fact',
        '',
        'steps:',
        '  derive:',
        '    command: mkdir $NODE_PATH.fact',
      ].join('\n'),
    );
    await cmd.shouldSucceed('pipeline define /work/test-attribution-fact.yaml');
    await cmd.shouldSucceed('service add attrpool-worker /opt/attrpool-worker');
    await cmd.shouldSucceed('service enable attrpool-worker');
    await cmd.shouldSucceed('service start attrpool-worker');

    await client.exec(`mknode -t file --as "name=a.bin" --as "mimetype=${TEST_MIME}" /work/a.bin`);
    await client.exec('chmod 644 /work/a.bin');
    const subject = await vfs.get(ADMIN_ACCESS, '/work/a.bin');

    await waitFor(async () => !!(await created('/work/a.bin.inline')) && !!(await created('/work/a.bin.pooled')), 'both steps to write');
    const instance = await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/test-attribution/${subject.id}`);
    const triggerWrite = instance.attrs.triggerWrite;
    assertExists(triggerWrite);

    await t.step('the instance keeps the write that set it off', async () => {
      const [record] = await vfs.audit(ADMIN_ACCESS, { id: triggerWrite.auditId });
      assertEquals([record.nodeId, record.uid], [subject.id, triggerWrite.uid]);
    });

    await t.step('inline and pooled steps write with the run and its cause', async () => {
      const sid = `pipeline:test-attribution/${subject.id}`;
      for (const path of ['/work/a.bin.inline', '/work/a.bin.redirect', '/work/a.bin.pooled']) {
        const record = await created(path);
        assertEquals([path, record?.sid, record?.cause], [path, sid, triggerWrite.auditId]);
      }
    });

    await t.step('the cause finds everything the write set off', async () => {
      const paths = new Set((await vfs.audit(ADMIN_ACCESS, { cause: triggerWrite.auditId })).map((r) => r.path));
      assertEquals([...paths].sort(), ['/work/a.bin.inline', '/work/a.bin.pooled', '/work/a.bin.redirect']);
    });

    await t.step('`audit` follows the chain from a derived node', async () => {
      const [derived] = await client.execJson<AuditEntry[]>(`audit --id ${(await vfs.get(ADMIN_ACCESS, '/work/a.bin.pooled')).id}`);
      const [cause] = await client.execJson<AuditEntry[]>(`audit --record ${derived.cause}`);
      assertEquals(cause.nodeId, subject.id);

      const text = await client.exec(`JSON_OUTPUT= audit -v --cause ${derived.cause} /work/a.bin.pooled`);
      assertEquals(String(text.data).includes(`sid pipeline:test-attribution/${subject.id}  cause ${derived.cause}`), true);
    });

    await t.step("what a run derives from a person's node is created in their name", async () => {
      for (const path of ['/work/a.bin.inline', '/work/a.bin.redirect', '/work/a.bin.pooled']) {
        assertEquals([path, (await vfs.get(ADMIN_ACCESS, path)).props.birthtime.uid], [path, ADMIN_UID]);
      }

      await vfs.create(ADMIN_ACCESS, 'file', '/work', 'c.bin', {
        attrs: { name: 'c.bin', mimetype: TEST_MIME },
        props: { mode: 0o600, birthtime: { uid: PERSON_UID, timestamp: Date.now() } },
      });
      // The trigger is an update.
      await vfs.update(ADMIN_ACCESS, '/work/c.bin', { props: { mode: 0o644 } });
      await waitFor(async () => !!(await created('/work/c.bin.inline')) && !!(await created('/work/c.bin.pooled')), 'both steps to write');
      for (const path of ['/work/c.bin.inline', '/work/c.bin.redirect', '/work/c.bin.pooled']) {
        const node = await vfs.get(ADMIN_ACCESS, path);
        assertEquals([path, node.props.birthtime.uid, node.props.uid], [path, PERSON_UID, ADMIN_UID]);
      }

      // A run started by hand is created in the same name.
      await cmd.shouldSucceed('pipeline start test-attribution-fact /work/c.bin');
      await waitFor(async () => !!(await created('/work/c.bin.fact')), 'the started step to write');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/work/c.bin.fact')).props.birthtime.uid, PERSON_UID);
    });

    await t.step("an event whose write left no record stands for the subject's latest write", async () => {
      const node = await vfs.create(ADMIN_ACCESS, 'file', '/work', 'b.bin', { attrs: { name: 'b.bin', mimetype: TEST_MIME }, props: { mode: 0o644 } });
      const [create] = await vfs.audit(ADMIN_ACCESS, { nodeId: node.id });
      // Changes nothing the trail keeps, so it leaves no record, but it is still an `updated` event.
      await vfs.update(ADMIN_ACCESS, '/work/b.bin', { props: { mode: 0o644 } });
      assertEquals((await vfs.audit(ADMIN_ACCESS, { nodeId: node.id })).length, 1);

      await waitFor(async () => !!(await created('/work/b.bin.inline')), 'the step to write');
      assertEquals((await created('/work/b.bin.inline'))?.cause, create.id);
    });

    await t.step('a run a fact starts records the write the fact was derived from', async () => {
      const fact = { id: 'fact-1', type: 'test.attribution.fact', subject: '/work/a.bin', time: Date.now(), write: triggerWrite };
      const handle = await vfs.open(ADMIN_ACCESS, EVENTS_NODE_PATH, { mode: 'a' });
      try {
        await handle.write(new TextEncoder().encode(serializeEvent(fact)));
      } finally {
        await handle.close();
      }

      await waitFor(async () => !!(await created('/work/a.bin.fact')), 'the fact-started step to write');
      const record = await created('/work/a.bin.fact');
      assertEquals([record?.sid, record?.cause], [`pipeline:test-attribution-fact/${subject.id}`, triggerWrite.auditId]);
    });
  } finally {
    await harness.stop();
  }
});
