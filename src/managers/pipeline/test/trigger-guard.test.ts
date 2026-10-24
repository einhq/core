/**
 * The in-flight guard runs before any shell evaluation.
 *
 * A trigger for a node whose instance is still running is dropped before the
 * trigger's `filter` and `skipIf` are evaluated, which would otherwise be up to
 * two shell spawns per definition per re-announcement.
 *
 * The filter here writes a marker file, so its side effect is observable: if the
 * marker count grows on a re-announcement, the guard did not fire first.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testguard';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function countLines(client: ShellClient, path: string): Promise<number> {
  const result = await client.exec(`cat ${path}`);
  if (!result.success) return 0;
  return String(result.data).trim().split('\n').filter(Boolean).length;
}

async function writeFile(vfs: Awaited<ReturnType<SystemTestHarness['startPrimary']>>['vfs'], path: string, body: string) {
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(body + '\n'));
  } finally {
    await handle.close();
  }
}

Deno.test({
  name: 'trigger guard runs before filter evaluation',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers && mkdir -p /work');

    // A step that never finishes on its own, so the instance stays `running`
    // for the whole test and every later trigger meets a live instance.
    await client.exec('mkfile /opt/steps/guard-slow && chmod 755 /opt/steps/guard-slow');
    await writeFile(vfs, '/opt/steps/guard-slow', 'sleep 30');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    // The filter records every evaluation. It always passes.
    const yaml = [
      'name: test-guard',
      'description: guard ordering fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      `      ${TEST_MIME}) echo eval >> /tmp/markers/filter-evals; exit 0;;`,
      '      *) exit 1;;',
      '    esac',
      '',
      'steps:',
      '  slow:',
      '    command: guard-slow',
    ].join('\n');
    await client.exec('mkfile /work/test-guard.yaml');
    await writeFile(vfs, '/work/test-guard.yaml', yaml);
    await client.exec('pipeline define /work/test-guard.yaml');

    await t.step('the first trigger evaluates the filter and starts an instance', async () => {
      await client.exec(`mknode -t file --as "name=g.bin" --as "mimetype=${TEST_MIME}" /work/g.bin`);
      await client.exec('chmod 644 /work/g.bin');

      await waitFor(async () => (await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-guard`)).success, 'instance created');
      assertEquals(await countLines(client, '/tmp/markers/filter-evals'), 1);
    });

    await t.step('re-announcing in-flight work costs no filter evaluation', async () => {
      const before = await countLines(client, '/tmp/markers/filter-evals');

      // Each touch re-emits `updated` for the same node, whose instance is still
      // running. Before the reorder every one of these paid for a filter spawn.
      for (let i = 0; i < 5; i++) {
        await client.exec(`attrs /work/g.bin -s nudge=${i}`);
      }

      // Give the engine time to consume all five.
      await new Promise((r) => setTimeout(r, 2000));

      assertEquals(
        await countLines(client, '/tmp/markers/filter-evals'),
        before,
        'the guard must reject before the filter runs',
      );

      // And still exactly one instance — the guard suppressed, it did not replace.
      const ids = await client.execJson<string[]>(`ls ${PIPELINE_INSTANCES_PATH}/test-guard`);
      assertEquals(ids.length, 1);
    });
  } finally {
    await harness.stop();
  }
});
