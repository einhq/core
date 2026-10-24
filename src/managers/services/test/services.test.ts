/**
 * Service lifecycle: add, enable, start, status, stop, restart, remove,
 * exercised through the service commands against a fixture service.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ServiceEntry } from '../../../lib/api/system.ts';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness, testCommands } from '../../../testing/mod.ts';
import { NODE_TYPE_LOG } from '../../../vfs/types/log.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test({
  name: 'service lifecycle',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  try {
    // Fixture: a long-running service that writes a heartbeat marker on start
    await client.exec('mkdir -p /opt/fixture-svc');
    await client.exec('mkfile /opt/fixture-svc/start.sh && chmod 755 /opt/fixture-svc/start.sh');
    await client.exec('mkfile /opt/fixture-svc/config.json');
    {
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/fixture-svc/start.sh', { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode('echo "fixture stdout"\necho "fixture stderr" >&2\nuuid >> /tmp/fixture-heartbeat\nsleep 3600\n'));
      } finally {
        await handle.close();
      }
    }
    {
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/fixture-svc/config.json', { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify({
          restartPolicy: 'on-failure',
          stopTimeout: 500,
          statusCommand: 'echo "captioning on CPU (json=$JSON_OUTPUT)"',
        })));
      } finally {
        await handle.close();
      }
    }

    await t.step('service add registers the service', async () => {
      await cmd.shouldSucceed('service add fixture-svc /opt/fixture-svc');

      const list = await client.execString('service list');
      assertStringIncludes(list, 'fixture-svc');
    });

    await t.step('service add is idempotent and can re-point the service', async () => {
      await cmd.shouldSucceed('service add fixture-svc /opt/fixture-svc');

      await client.exec('mkdir -p /opt/fixture-svc-v2');
      await client.exec('ln -s /opt/fixture-svc/start.sh /opt/fixture-svc-v2/start.sh');
      await client.exec('ln -s /opt/fixture-svc/config.json /opt/fixture-svc-v2/config.json');
      await cmd.shouldSucceed('service add fixture-svc /opt/fixture-svc-v2');

      const link = await vfs.get(ADMIN_ACCESS, '/etc/services/available/fixture-svc', {
        follow: false,
      });
      assertEquals(link.props.softlink, '/opt/fixture-svc-v2');
    });

    await t.step('service start requires enable first', async () => {
      await cmd.shouldFail('service start fixture-svc');
    });

    await t.step('service start runs the script once enabled', async () => {
      await cmd.shouldSucceed('service enable fixture-svc');
      await cmd.shouldSucceed('service start fixture-svc');

      const status = await client.execJson<{ status: string; stdoutLog: string; stderrLog: string }>('service status fixture-svc');
      assertEquals(status.status, 'running');
      assertEquals(status.stdoutLog, '/var/logs/services/fixture-svc/stdout.log');
      assertEquals(status.stderrLog, '/var/logs/services/fixture-svc/stderr.log');

      const instance = harness.serviceManager?.get('fixture-svc');
      assertEquals(instance?.config.restartPolicy, 'on-failure');
      assertEquals(instance?.config.stopTimeout, 500);

      const beats = (await client.execString('cat /tmp/fixture-heartbeat')).trim().split('\n');
      assertEquals(beats.length, 1);
    });

    await t.step('service output uses tail-able log nodes under /var/logs', async () => {
      const stdout = '/var/logs/services/fixture-svc/stdout.log';
      const stderr = '/var/logs/services/fixture-svc/stderr.log';

      await waitFor(async () => (await client.execString(`tail -n 1 ${stdout}`)).includes('fixture stdout'), 'service stdout log');
      await waitFor(async () => (await client.execString(`tail -n 1 ${stderr}`)).includes('fixture stderr'), 'service stderr log');

      assertEquals((await vfs.get(ADMIN_ACCESS, stdout)).type, NODE_TYPE_LOG);
      assertEquals((await vfs.get(ADMIN_ACCESS, stderr)).type, NODE_TYPE_LOG);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/etc/services/logs/fixture-svc'), false);
      assertEquals((await client.execString(`tail -n 1 ${stdout}`)).trim(), 'fixture stdout');
      assertEquals((await client.execString(`tail -n 1 ${stderr}`)).trim(), 'fixture stderr');
    });

    await t.step('service-list --detail carries the line the service reports about itself', async () => {
      const services = await client.execJson<ServiceEntry[]>('service-list --detail');
      const fixture = services.find((service) => service.name === 'fixture-svc');

      // `running` is all the manager knows; the detail is the service's own line.
      //
      // `json=0`: the list runs with JSON_OUTPUT=1 and the shell passes the environment
      // down, so the status command runs with JSON mode forced off, or a command that
      // honours it would answer with a serialized object.
      assertEquals(fixture?.detail, 'captioning on CPU (json=0)');
      // Every other service declares no statusCommand, so it reports nothing rather than ''.
      for (const service of services) {
        if (service.name !== 'fixture-svc') assertEquals(service.detail, undefined);
      }

      // Without the flag nothing is asked: a plain listing must not run every probe.
      const plain = await client.execJson<ServiceEntry[]>('service-list');
      assertEquals(plain.find((service) => service.name === 'fixture-svc')?.detail, undefined);
    });

    await t.step('service restart runs the script again', async () => {
      await cmd.shouldSucceed('service restart fixture-svc');

      const status = await client.execString('service status fixture-svc');
      assertStringIncludes(status, 'running');

      const beats = (await client.execString('cat /tmp/fixture-heartbeat')).trim().split('\n');
      assertEquals(beats.length, 2);

      // The interrupted old process may report failure. Its exit must not
      // restart or replace the new instance after the explicit restart returns.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const settledBeats = (await client.execString('cat /tmp/fixture-heartbeat')).trim().split('\n');
      assertEquals(settledBeats.length, 2);
    });

    await t.step('service stop halts the service', async () => {
      await cmd.shouldSucceed('service stop fixture-svc');

      const status = await client.execString('service status fixture-svc');
      assertEquals(status.includes('running'), false, status);

      // on-failure applies to crashes, not the non-zero exit an interrupted
      // command can produce during an intentional stop.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assertEquals(harness.serviceManager?.getStatus('fixture-svc'), 'stopped');
    });

    await t.step('a stopped service is not asked for a detail', async () => {
      const services = await client.execJson<ServiceEntry[]>('service-list --detail');
      const fixture = services.find((service) => service.name === 'fixture-svc');

      // It still declares a statusCommand; it is simply not running, and probing a service an
      // operator has deliberately stopped is work the dashboard has no business doing.
      assertEquals(fixture?.status, 'stopped');
      assertEquals(fixture?.detail, undefined);
    });

    await t.step('disable clears the enabled flag', async () => {
      await cmd.shouldSucceed('service disable fixture-svc');
      const after = await client.execJson<{ enabled: boolean }>('service status fixture-svc');
      assertEquals(after.enabled, false);
    });

    await t.step('service remove deregisters it', async () => {
      await cmd.shouldSucceed('service remove fixture-svc');

      const list = await client.execString('service list');
      assertEquals(list.includes('fixture-svc'), false, list);
    });

    await t.step('on-failure restarts crashes and stops at maxRestarts', async () => {
      await client.exec('mkdir -p /opt/crashing-svc');
      await client.exec('mkfile /opt/crashing-svc/start.sh && chmod 755 /opt/crashing-svc/start.sh');
      await client.exec('mkfile /opt/crashing-svc/config.json');

      const startHandle = await vfs.open(ADMIN_ACCESS, '/opt/crashing-svc/start.sh', { mode: 'w' });
      try {
        await startHandle.write(new TextEncoder().encode('uuid >> /tmp/crashing-heartbeat\nfalse\n'));
      } finally {
        await startHandle.close();
      }

      const configHandle = await vfs.open(ADMIN_ACCESS, '/opt/crashing-svc/config.json', { mode: 'w' });
      try {
        await configHandle.write(new TextEncoder().encode(JSON.stringify({
          restartPolicy: 'on-failure',
          maxRestarts: 2,
          restartWindow: 10000,
        })));
      } finally {
        await configHandle.close();
      }

      await cmd.shouldSucceed('service add crashing-svc /opt/crashing-svc');
      await cmd.shouldSucceed('service enable crashing-svc');
      await cmd.shouldSucceed('service start crashing-svc');

      await waitFor(() => {
        const instance = harness.serviceManager?.get('crashing-svc');
        return instance?.status === 'failed' && instance.restartCount === 2;
      }, 'crashing service to exhaust its restart limit');
      // `failed` is also the state during the retry delay. Wait through that
      // delay so the assertion observes the final, rejected restart.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const beats = (await client.execString('cat /tmp/crashing-heartbeat')).trim().split('\n');
      assertEquals(beats.length, 3);

      const instance = harness.serviceManager?.get('crashing-svc');
      assertEquals(instance?.status, 'failed');
      assertEquals(instance?.restartCount, 2);

      // Replace the failed fixture with a stoppable process so teardown also
      // exercises recovery from a terminal failed state without leaving a
      // stale instance in the harness.
      const replacement = await vfs.open(ADMIN_ACCESS, '/opt/crashing-svc/start.sh', { mode: 'w' });
      try {
        await replacement.write(new TextEncoder().encode('sleep 3600\n'));
      } finally {
        await replacement.close();
      }
      await cmd.shouldSucceed('service restart crashing-svc');
      await cmd.shouldSucceed('service stop crashing-svc');

      await cmd.shouldSucceed('service disable crashing-svc');
      await cmd.shouldSucceed('service remove crashing-svc');
    });

    await t.step('stopping a loop service ends the loop, not just the command it is in', async () => {
      // A pass, then a long sleep, forever. The stop ends the loop rather than
      // only the sleep, so it returns without waiting out the force-stop grace.
      await client.exec('mkdir -p /opt/loop-svc');
      await client.exec('mkfile /opt/loop-svc/start.sh && chmod 755 /opt/loop-svc/start.sh');
      await client.exec('mkfile /opt/loop-svc/config.json');

      const startHandle = await vfs.open(ADMIN_ACCESS, '/opt/loop-svc/start.sh', { mode: 'w' });
      try {
        await startHandle.write(new TextEncoder().encode('while true; do\n  uuid >> /tmp/loop-heartbeat\n  sleep 3600\ndone\n'));
      } finally {
        await startHandle.close();
      }

      const configHandle = await vfs.open(ADMIN_ACCESS, '/opt/loop-svc/config.json', { mode: 'w' });
      try {
        await configHandle.write(new TextEncoder().encode(JSON.stringify({ restartPolicy: 'on-failure', stopTimeout: 5000 })));
      } finally {
        await configHandle.close();
      }

      await cmd.shouldSucceed('service add loop-svc /opt/loop-svc');
      await cmd.shouldSucceed('service enable loop-svc');
      await cmd.shouldSucceed('service start loop-svc');
      await waitFor(async () => (await client.execString('cat /tmp/loop-heartbeat')).trim().length > 0, 'the first pass');

      const started = Date.now();
      await cmd.shouldSucceed('service stop loop-svc');
      const elapsed = Date.now() - started;

      // Well inside the grace: a stop that had to be forced takes at least all of it.
      assertEquals(elapsed < 2500, true, `service stop took ${elapsed}ms`);
      assertEquals(harness.serviceManager?.getStatus('loop-svc'), 'stopped');
      // The loop did not get another pass in on its way out.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const beats = (await client.execString('cat /tmp/loop-heartbeat')).trim().split('\n');
      assertEquals(beats.length, 1);

      await cmd.shouldSucceed('service disable loop-svc');
      await cmd.shouldSucceed('service remove loop-svc');
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
