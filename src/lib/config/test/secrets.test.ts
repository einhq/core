/**
 * A key to another service is in no shell's environment and no file anyone but the administrator
 * reads; the settings say only whether it is set. `serviceKey` hands it out for the system's own
 * address of its service and nowhere else, and the administrator's key wins over the deployment's.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, ADMIN_UID } from '../../access/constants.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';
import type { ConfigEntry } from '../types.ts';
import { registerConfigOptions, unregisterConfigOptions, validateConfigOption } from '../registry.ts';
import { isSecretKey, serviceKey } from '../read-settings.ts';

const testCtx = createTestContext({ boot: true });

const URL_KEY = 'CFG_EXAMPLE_URL';
const KEY = 'CFG_EXAMPLE_KEY';
const SET = 'sk-invented-0123';
const DEPLOYED = 'sk-deployed-4567';

Deno.test('a secret is named CFG_*_KEY, and only a secret is', () => {
  assert(isSecretKey('CFG_EMS_KEY'));
  assert(!isSecretKey('CFG_LLM_MAX_TOKENS'));
  assert(!isSecretKey('EMS_KEY'));

  const option = { key: KEY, scope: 'system' as const, type: 'secret' as const, default: '', label: 'Key', description: '', group: 'Example' };
  assertEquals(validateConfigOption(option), undefined);
  assertStringIncludes(validateConfigOption({ ...option, type: 'string' }) ?? '', 'CFG_*_KEY');
  assertStringIncludes(validateConfigOption({ ...option, key: 'CFG_EXAMPLE_TOKEN' }) ?? '', 'CFG_*_KEY');
  assertStringIncludes(validateConfigOption({ ...option, default: 'sk-built-in' }) ?? '', 'no default');
});

Deno.test({
  name: 'secret settings',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  registerConfigOptions('example', [
    { key: URL_KEY, scope: 'system', type: 'string', default: '', label: 'Example address', description: '', group: 'Example' },
    { key: KEY, scope: 'system', type: 'secret', default: '', label: 'Example key', description: '', group: 'Example' },
  ]);
  const admin = await testCtx.server.createShellClient();
  const guest = await testCtx.server.createShellClient({ login: false });
  const keyFor = (env: Record<string, string>) => serviceKey({ sys: { vfs }, env }, KEY, URL_KEY);
  // The guest echoes only where visitors may browse; its environment is the same either way.
  const guestEcho = async (text: string) => {
    await admin.execString('config set CFG_GUEST_BROWSING true');
    try {
      return (await guest.execString(`echo "${text}"`)).trim();
    } finally {
      await admin.execString('config unset CFG_GUEST_BROWSING');
    }
  };
  const entry = async (client = admin) => (await client.execJson<ConfigEntry[]>('config list')).find((candidate) => candidate.key === KEY)!;

  try {
    await t.step('set by the administrator, it is not said back', async () => {
      // A file made by hand, as everyone may read it, is closed when it is written.
      await admin.exec('echo > /etc/keys && chmod 0644 /etc/keys');
      const out = await admin.execString(`JSON_OUTPUT=0 config set ${KEY} ${SET}`);
      assertEquals(out.trim(), `${KEY} set`);
      const answer = await admin.execJson<{ value: string }>(`config set ${KEY} ${SET}`);
      assertEquals(answer.value, '');
    });

    await t.step('only the administrator reads /etc/keys, and no shell sources it', async () => {
      const { props } = await vfs.get(ADMIN_ACCESS, '/etc/keys');
      assertEquals([props.uid, props.mode], [ADMIN_UID, 0o600]);
      await testCommands(guest).shouldFail('cat /etc/keys');

      const fresh = await testCtx.server.createShellClient();
      try {
        assertEquals(await guestEcho(`[$${KEY}]`), '[]');
        assertEquals((await fresh.execString(`echo "[$${KEY}]"`)).trim(), '[]');
      } finally {
        fresh.close();
      }
    });

    await t.step('the settings say that it is set, never what it is', async () => {
      assertEquals([(await entry(admin)).value, (await entry(admin)).source], ['', 'system']);
      assertEquals((await admin.execString(`JSON_OUTPUT=0 config get ${KEY}`)).trim(), '(set)');
      // The guest lists the settings, as the sign-in page does, and gets nothing else.
      for (const client of [admin, guest]) assert(!(await client.execString('JSON_OUTPUT=0 config list')).includes(SET));
      assertEquals((await guest.exec(`config get ${KEY}`)).success, false);
    });

    await t.step("it goes to the system's own address and nowhere else", async () => {
      // No address anywhere: the caller and the system both mean the client's default.
      assertEquals(await keyFor({}), SET);
      assertEquals(await keyFor({ [URL_KEY]: 'http://elsewhere.example' }), undefined);

      await admin.exec(`config set ${URL_KEY} http://ours.example`);
      assertEquals(await keyFor({ [URL_KEY]: 'http://ours.example' }), SET);
      assertEquals(await keyFor({ [URL_KEY]: 'http://elsewhere.example' }), undefined);
      assertEquals(await keyFor({}), undefined);
      await admin.exec(`config unset ${URL_KEY}`);
    });

    await t.step("the deployment's key, from this process's environment, under the administrator's", async () => {
      Deno.env.set(KEY, DEPLOYED);
      try {
        assertEquals(await keyFor({}), SET);

        const out = await admin.execString(`JSON_OUTPUT=0 config unset ${KEY}`);
        assert(!out.includes(DEPLOYED));
        assertEquals(await keyFor({}), DEPLOYED);
        assertEquals([(await entry()).value, (await entry()).source], ['', 'environment']);
        assertEquals(await guestEcho(`[$${KEY}]`), '[]');
      } finally {
        Deno.env.delete(KEY);
      }
      assertEquals(await keyFor({}), undefined);
      assertEquals((await entry()).source, 'default');
    });

    await t.step('config publish leaves a secret out of /etc/environment', async () => {
      await admin.exec(`${KEY}=${DEPLOYED} ${URL_KEY}=http://ours.example config publish`);
      const published = await admin.execString('cat /etc/environment');
      assertStringIncludes(published, URL_KEY);
      assert(!published.includes(KEY) && !published.includes(DEPLOYED));
    });
  } finally {
    unregisterConfigOptions('example');
    guest.close();
    admin.close();
    await testCtx.teardown();
  }
});
