/**
 * The supervisor commands pass EiN's requests to the supervisor at CFG_SUPERVISOR_URL, with its key
 * for the system's own address alone, and its answers and refusals back; an installation without a
 * supervisor says so.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';
import type { ModuleEntry, SupervisorStatus } from '../../../../lib/api/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

type Request = { method: string; path: string; authorization: string | null; body: unknown };

/** A stand-in supervisor: what it was asked, and its answers, a refusal for an install of llm. */
const standIn = () => {
  const requests: Request[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
    const path = new URL(request.url).pathname;
    const text = await request.text();
    requests.push({ method: request.method, path, authorization: request.headers.get('Authorization'), body: text ? JSON.parse(text) : undefined });
    if (path === '/v0/status') {
      return Response.json({
        version: '0.1.0',
        engine: 'podman',
        updateAt: '04:00',
        services: [{
          name: 'ems',
          title: 'the media service',
          optional: true,
          installed: false,
          gives: ['the graphics card'],
          wanted: { line: '0.4', modules: [{ module: 'ems', range: '^0.4.4' }] },
        }, {
          name: 'core',
          title: 'EiN',
          optional: false,
          installed: true,
          gives: [],
          state: 'running',
          image: 'ghcr.io/einhq/core:0.1.1',
          version: '0.1.1',
          available: { version: '0.1.2', image: 'ghcr.io/einhq/core:0.1.2' },
        }, {
          name: 'db',
          title: 'the database',
          optional: false,
          installed: true,
          gives: [],
          state: 'running',
          image: 'ghcr.io/einhq/db:0.1.0',
          version: '0.1.0',
        }],
        job: null,
      });
    }
    if (path === '/v0/install/llm') return Response.json({ error: 'the language model is installed already' }, { status: 409 });
    return Response.json({ job: { id: '1', args: [], by: 'admin', startedAt: '' } }, { status: 202 });
  });
  return { requests, server, url: `http://127.0.0.1:${server.addr.port}` };
};

Deno.test({ name: 'supervisor', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const supervisor = standIn();
  try {
    await t.step("without a supervisor, status says the services are setup.sh's", async () => {
      const status = await client.execJson<SupervisorStatus>('supervisor status');
      assertEquals(status, { configured: false, services: [], job: null });
      assertStringIncludes(`${(await client.exec('JSON_OUTPUT=0 supervisor status')).data}`, 'no supervisor');
    });

    await t.step('status passes on what the supervisor says, asked with its key', async () => {
      await client.exec(`config set CFG_SUPERVISOR_URL ${supervisor.url} && config set CFG_SUPERVISOR_KEY a-supervisor-key`);
      const status = await client.execJson<SupervisorStatus>('supervisor status');
      assertEquals(status.configured, true);
      assertEquals(status.services[0].name, 'ems');
      assertEquals(supervisor.requests.at(-1), { method: 'GET', path: '/v0/status', authorization: 'Bearer a-supervisor-key', body: undefined });
      const said = `${(await client.exec('JSON_OUTPUT=0 supervisor status')).data}`;
      assertStringIncludes(said, 'asked for by ems ^0.4.4');
      assertStringIncludes(said, 'core  running · ghcr.io/einhq/core:0.1.1 · update to 0.1.2');
      assertStringIncludes(said, 'db    running · ghcr.io/einhq/db:0.1.0\n');
    });

    await t.step('install and update ask for what they name, saying who asks', async () => {
      assert((await client.exec('supervisor install ems')).success);
      assertEquals(supervisor.requests.at(-1)?.path, '/v0/install/ems');
      assertEquals(supervisor.requests.at(-1)?.body, { by: 'admin' });
      assert((await client.exec('supervisor update core db')).success);
      assertEquals(supervisor.requests.at(-1)?.path, '/v0/update');
      assertEquals(supervisor.requests.at(-1)?.body, { by: 'admin', services: ['core', 'db'] });
      await client.exec('supervisor update');
      assertEquals(supervisor.requests.at(-1)?.body, { by: 'admin' });
    });

    await t.step('a refusal is said, and fails the command', async () => {
      const result = await client.exec('JSON_OUTPUT=0 supervisor install llm');
      assertEquals(result.success, false);
      assertStringIncludes(`${result.data}${result.error ?? ''}`, 'the language model is installed already');
    });

    await t.step('an address put before the command is not asked, nor given the key', async () => {
      const other = standIn();
      try {
        const before = supervisor.requests.length;
        await client.exec(`CFG_SUPERVISOR_URL=${other.url} supervisor status`);
        assertEquals(other.requests, []);
        assertEquals(supervisor.requests.length, before + 1);
      } finally {
        await other.server.shutdown();
      }
    });

    await t.step('a supervisor that does not answer is an answer with its error in JSON', async () => {
      await supervisor.server.shutdown();
      const status = await client.execJson<SupervisorStatus>('supervisor status');
      assertEquals(status.configured, true);
      assert(status.error?.includes('does not answer'));
      assertEquals((await client.exec('JSON_OUTPUT=0 supervisor status')).success, false);
    });

    await t.step('mod list gives the services beside EiN a module talks to', async () => {
      const name = `talks-${crypto.randomUUID().slice(0, 8)}`;
      await client.exec(`mkdir -p $MOD_PATH/${name} && echo '{"name":"${name}","version":"1.0.0","services":{"ems":"^0.4.4"}}' > $MOD_PATH/${name}/mod.json`);
      const entry = (await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === name);
      assertEquals(entry?.serviceRanges, { ems: '^0.4.4' });
    });
  } finally {
    await client.exec('config unset CFG_SUPERVISOR_URL CFG_SUPERVISOR_KEY');
    await supervisor.server.shutdown().catch(() => {});
    await testCtx.teardown();
  }
});
