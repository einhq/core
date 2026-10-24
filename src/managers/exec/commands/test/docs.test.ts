/**
 * `docs commands`, `docs node-types` and `docs env`: the commands on PATH with their specs, core's descriptions, each installed module's, and what is in
 * use or set that nothing describes, so the documentation cannot fall behind the installation.
 */

import { assert, assertEquals } from '@std/assert';
import { exists } from '@std/fs/exists';
import { walk } from '@std/fs/walk';
import { join, relative } from '@std/path';
import { CORE_OPTIONS } from '../../../../lib/config/options.ts';
import { pathEnv } from '../../../../lib/paths.ts';
import { CORE_ENVIRONMENT, PATH_DESCRIPTIONS } from '../../../../lib/reference/environment.ts';
import { REPO_ROOT, repoModules } from '../../../../modules/repo.ts';
import { CORE_NODE_TYPES } from '../../../../lib/reference/node-types.ts';
import { checkReference } from '../../../../modules/validate.ts';
import type { ModuleManifest } from '../../../../modules/types.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';
import type { EnvReference, ListedCommand, NodeTypeReference } from '../../../../lib/api/docs.ts';

const testCtx = createTestContext();
let client: ShellClient;

const MANIFEST = {
  name: 'docs-fixture',
  version: '0.1.0',
  nodeTypes: [{ type: 'sailboat', label: 'Sailboat', category: 'content', description: 'A boat with sails.' }],
  environment: [{ key: 'SAILBOAT_WIND', kind: 'option', default: 'west', description: 'Where the wind blows from.' }],
};

Deno.test({ name: 'docs', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const dir = `$MOD_PATH/${MANIFEST.name}`;
  try {
    await client.exec(`mkdir -p ${dir} && echo '${JSON.stringify(MANIFEST)}' > ${dir}/mod.json`);

    await t.step('node types: core and module descriptions, and what is in use undescribed', async () => {
      const tmp = `/tmp/docs-${crypto.randomUUID()}`;
      await client.exec(`mkdir -p ${tmp} && mknode -t sailboat ${tmp}/one && mknode -t kayak ${tmp}/two`);
      const types = new Map((await client.execJson<NodeTypeReference[]>('docs node-types')).map((entry) => [entry.type, entry]));

      assertEquals(types.get('directory')?.owner, undefined);
      assert((types.get('directory')?.count ?? 0) > 0);
      assertEquals(types.get('sailboat')?.owner, 'docs-fixture');
      assertEquals(types.get('sailboat')?.label, 'Sailboat');
      assertEquals(types.get('sailboat')?.count, 1);
      // In use, described nowhere: listed all the same.
      assertEquals(types.get('kayak'), { type: 'kayak', count: 1 });
      // Described, none yet.
      assertEquals(types.get('track')?.count ?? 0, 0);
      // Built-in commands are nodes nobody stores; they are counted all the same.
      assert((types.get('command')?.count ?? 0) > 50);
    });

    await t.step("env: descriptions with this shell's values; deployment and secrets never echoed", async () => {
      const entries = await client.execJson<EnvReference[]>('SAILBOAT_WIND=north EXTRA_THING=1 SOME_TOKEN=hush lower_local=1 docs env');
      const find = (key: string, kind?: string) => entries.find((entry) => entry.key === key && (!kind || entry.kind === kind));

      assertEquals(find('SAILBOAT_WIND')?.owner, 'docs-fixture');
      assertEquals(find('SAILBOAT_WIND')?.value, 'north');
      assert(find('USER', 'session')?.value);
      assertEquals(find('ALBUMS_PATH', 'path')?.value, pathEnv().ALBUMS_PATH);
      assert(find('POSTGRES_URL', 'deployment'));
      assertEquals(find('POSTGRES_URL', 'deployment')?.value, undefined);
      // The same name as a host directory to the process and a tree path in the shell.
      assertEquals(find('DOCS_PATH', 'deployment')?.value, undefined);
      assertEquals(find('DOCS_PATH', 'path')?.value, pathEnv().DOCS_PATH);

      assertEquals(find('EXTRA_THING'), { key: 'EXTRA_THING', kind: 'session', description: '', value: '1', undescribed: true });
      assertEquals(find('SOME_TOKEN')?.value, undefined);
      assertEquals(find('lower_local'), undefined);
      assertEquals(find('ADMIN_USERNAME')?.kind, 'system');
      // Registered settings are `config list`'s; an unregistered CFG_* is a gap, and shown as one.
      assert(!entries.some((entry) => entry.key === 'CFG_SSH_PORT' || entry.key === 'HISTSIZE'));
      const stray = (await client.execJson<EnvReference[]>('CFG_NOT_REGISTERED=1 docs env')).find((entry) => entry.key === 'CFG_NOT_REGISTERED');
      assertEquals(stray?.undescribed, true);
    });

    await t.step('commands: every command on PATH with its spec and whose it is, sorted', async () => {
      const commands = await client.execJson<ListedCommand[]>('docs commands');
      const ls = commands.find((entry) => entry.name === 'ls');
      assertEquals([ls?.module, ls?.spec.name], ['core', 'ls']);
      assert(commands.some((entry) => entry.name === 'docs-commands'));
      assertEquals(commands.map((entry) => entry.name), commands.map((entry) => entry.name).toSorted((a, b) => a.localeCompare(b)));
    });

    await t.step('text output', async () => {
      const text = `${(await client.exec('JSON_OUTPUT=0 docs node-types')).data}`;
      assert(text.includes('sailboat'), text);
    });
  } finally {
    await client.exec(`rm -r ${dir}`);
    await testCtx.teardown();
  }
});

Deno.test('every layout variable is described, and core describes each node type once', () => {
  const undescribed = Object.keys(pathEnv()).filter((key) => key !== 'PATH' && key !== 'TMPDIR' && !PATH_DESCRIPTIONS[key]);
  assertEquals(undescribed, []);
  const types = CORE_NODE_TYPES.map((doc) => doc.type);
  assertEquals(types.length, new Set(types).size);
});

Deno.test('every CFG_ name the source reads is a setting or a described variable', async () => {
  const known = new Set([...CORE_OPTIONS, ...CORE_ENVIRONMENT].map((entry) => entry.key));
  for (const { dir } of repoModules()) {
    const manifest = JSON.parse(await Deno.readTextFile(join(dir, 'mod.json'))) as ModuleManifest;
    for (const entry of [...(manifest.config?.options ?? []), ...(manifest.environment ?? [])]) known.add(entry.key);
  }
  const unknown = new Set<string>();
  const skip = [/[/\\]test[/\\]/, /[/\\]fixtures[/\\]/, /\.test\.ts$/, /src[/\\]builtin[/\\]ui[/\\]ui[/\\]/];
  for (const root of ['src', 'modules']) {
    // A checkout need not have any modules.
    if (!await exists(join(REPO_ROOT, root))) continue;
    for await (const entry of walk(join(REPO_ROOT, root), { includeDirs: false, exts: ['.ts', '.tsx', '.sh', ''] })) {
      const path = relative(REPO_ROOT, entry.path);
      if (skip.some((pattern) => pattern.test(path))) continue;
      for (const [key] of (await Deno.readTextFile(entry.path)).matchAll(/\bCFG_[A-Z0-9_]*[A-Z0-9]\b/g)) {
        if (!known.has(key)) unknown.add(`${key} (${path})`);
      }
    }
  }
  assertEquals([...unknown].sort(), []);
});

Deno.test('checkReference: malformed descriptions warn, a non-array is an error', () => {
  const base = { name: 'm', version: '1.0.0' } as ModuleManifest;
  assertEquals(checkReference({ ...base, ...MANIFEST } as ModuleManifest), { errors: [], warnings: [] });
  assertEquals(checkReference({ ...base, nodeTypes: {} } as unknown as ModuleManifest).errors, ['m: nodeTypes must be an array']);
  const warned = checkReference({
    ...base,
    nodeTypes: [{ type: 'x', label: 'X', description: 'An x.', category: 'weird' }],
    environment: [{ key: 'bad key', kind: 'option', description: 'd' }, { key: 'OK', kind: 'nowhere', description: 'd' }],
  } as unknown as ModuleManifest);
  assertEquals(warned.warnings.length, 3);
});
