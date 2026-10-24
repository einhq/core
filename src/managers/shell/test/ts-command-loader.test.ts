/**
 * Specifier rewriting for `#!ts` commands.
 *
 * The staged copy is what Deno actually imports, so these assertions are about the exact text
 * that determines whether a module installed after boot can run at all.
 */

import { MOD_PATH } from '../../../lib/paths.ts';
import { assertEquals, assertNotEquals, assertRejects, assertStrictEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { createTestVfs } from '../../../testing/mod.ts';
import type { FileAttrs } from '../../../vfs/types/file.ts';
import { cachedTsCommand, clearTsCommandCache, loadTsCommand, moduleRootOf, stageTsCommand } from '../ts-command-loader.ts';

/** The text of a staged copy. */
const read = async (url: string): Promise<string> => await (await fetch(url)).text();

/** Create or overwrite a file, with its directories. */
const write = async (vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'], path: string, body: string) => {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = '';
  for (const part of parts) {
    await vfs.ensure(ADMIN_ACCESS, 'directory', dir || '/', part, { props: { mode: 0o755 } });
    dir = `${dir}/${part}`;
  }
  await vfs.ensure(ADMIN_ACCESS, 'file', dir || '/', name, {
    props: { mode: 0o755 },
    attrs: { name, mimetype: 'text/plain' },
  });
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(body));
  } finally {
    await handle.close();
  }
};

Deno.test('moduleRootOf', async (t) => {
  await t.step('finds the owning module of a bin', () => {
    assertEquals(moduleRootOf(`${MOD_PATH}/media/bin/exif-extract`, MOD_PATH), `${MOD_PATH}/media`);
  });

  await t.step('is undefined outside the modules path, so core bins are unaffected', () => {
    assertEquals(moduleRootOf('/bin/ls', MOD_PATH), undefined);
  });
});

Deno.test('#!ts specifier rewriting', async (t) => {
  const { vfs } = await createTestVfs();

  const stageUrl = async (commandPath: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, commandPath, { mode: 'r' });
    let source: string;
    try {
      source = new TextDecoder().decode(await handle.read(1024 * 64));
    } finally {
      await handle.close();
    }
    return await stageTsCommand(vfs, ADMIN_ACCESS, commandPath, source, MOD_PATH);
  };
  const stage = async (commandPath: string): Promise<string> => await read((await stageUrl(commandPath)).url);

  await write(
    vfs,
    `${MOD_PATH}/demo/mod.json`,
    JSON.stringify({
      name: 'demo',
      version: '0.1.0',
      imports: {
        '@std/path': 'jsr:@std/path@^1.1.3',
        '@demo/lib': './lib/thing.ts',
      },
      dependencies: { other: '^0.2.0' },
    }),
  );
  await write(vfs, `${MOD_PATH}/demo/lib/thing.ts`, `import { shared } from '@other/shared';\nexport const thing = shared;\n`);
  // The provider: one export, and a private alias its own files use that no dependent restates.
  await write(
    vfs,
    `${MOD_PATH}/other/mod.json`,
    JSON.stringify({
      name: 'other',
      version: '0.2.0',
      exports: { './shared': './lib/shared.ts' },
      imports: { '@other/internal': './lib/internal.ts' },
    }),
  );
  await write(vfs, `${MOD_PATH}/other/lib/shared.ts`, `import { base } from '@other/internal';\nexport const shared = base + 0;\n`);
  await write(vfs, `${MOD_PATH}/other/lib/internal.ts`, `export const base = 42;\n`);
  await write(vfs, `${MOD_PATH}/demo/types/local.ts`, `export type Local = { a: number };\n`);
  await write(vfs, `${MOD_PATH}/demo/lib/local.ts`, `export const local = 1;\n`);

  await write(
    vfs,
    `${MOD_PATH}/demo/bin/demo-cmd`,
    [
      '#!ts',
      `import { join } from '@std/path';`,
      `import { thing } from '@demo/lib';`,
      `import { shared } from '@other/shared';`,
      `import { local } from '../lib/local.ts';`,
      `import type { Local } from '../types/local.ts';`,
      `import type { Command } from '@ein/client';`,
      `export default Object.assign(() => 0, { spec: { name: 'demo-cmd' } });`,
    ].join('\n') + '\n',
  );

  const staged = await stage(`${MOD_PATH}/demo/bin/demo-cmd`);

  await t.step('the shebang is stripped', () => {
    assertEquals(staged.startsWith('#!ts'), false, staged.slice(0, 40));
  });

  await t.step('a manifest specifier mapping to jsr: is rewritten to the jsr: URL', () => {
    // This is the whole mechanism: jsr:/npm: need no import map, so a module installed after
    // the process started still resolves.
    assertStringIncludes(staged, `from 'jsr:@std/path@^1.1.3'`);
  });

  await t.step('a module-relative specifier points at a staged copy', () => {
    const match = staged.match(/import \{ thing \} from '(blob:[^']+)'/);
    assertEquals(Boolean(match), true, staged);
  });

  await t.step("a dependency's export resolves to the installed module's file", async () => {
    const match = staged.match(/import \{ shared \} from '(blob:[^']+)'/);
    assertEquals(Boolean(match), true, staged);
    assertStringIncludes(await read(match![1]), 'export const shared = base');
  });

  await t.step("a provider's private alias resolves under the provider's own manifest", async () => {
    // demo's manifest knows nothing about '@other/internal': each file is rewritten with its own
    // module's manifest, so a dependent does not restate a provider's internal aliases.
    const match = staged.match(/import \{ shared \} from '(blob:[^']+)'/);
    const body = await read(match![1]);
    assertEquals(body.includes(`'@other/internal'`), false, body);
    assertStringIncludes(body, `import { base } from 'blob:`);
  });

  await t.step('two dependents share one staged copy of an export', async () => {
    // One copy per process is what keeps a provider's classes one class: `instanceof EmsError`
    // in media has to hold for an error thrown inside ems.
    await write(vfs, `${MOD_PATH}/third/mod.json`, JSON.stringify({ name: 'third', version: '0.1.0', dependencies: { other: '^0.2.0' } }));
    await write(vfs, `${MOD_PATH}/third/bin/third-cmd`, `#!ts\nimport { shared } from '@other/shared';\nexport default shared;\n`);

    const fromDemo = staged.match(/import \{ shared \} from '(blob:[^']+)'/)![1];
    const fromThird = (await stage(`${MOD_PATH}/third/bin/third-cmd`)).match(/import \{ shared \} from '(blob:[^']+)'/)![1];
    assertEquals(fromThird, fromDemo);
  });

  await t.step('importing a module that is not a declared dependency is refused', async () => {
    await write(vfs, `${MOD_PATH}/loner/mod.json`, JSON.stringify({ name: 'loner', version: '0.1.0' }));
    await write(vfs, `${MOD_PATH}/loner/bin/loner-cmd`, `#!ts\nimport { shared } from '@other/shared';\nexport default shared;\n`);
    await assertRejects(() => stage(`${MOD_PATH}/loner/bin/loner-cmd`), Error, "does not list 'other' in its dependencies");
  });

  await t.step('importing a path the dependency does not export is refused', async () => {
    await write(vfs, `${MOD_PATH}/demo/bin/peek-cmd`, `#!ts\nimport { base } from '@other/internal';\nexport default base;\n`);
    await assertRejects(() => stage(`${MOD_PATH}/demo/bin/peek-cmd`), Error, "'@other/internal' is not exported by 'other'");
  });

  await t.step('a relative import resolves against the bin', async () => {
    // The staged copy does not sit next to the original, so '../lib/local.ts' resolves only
    // because the local graph is staged too.
    const match = staged.match(/import \{ local \} from '(blob:[^']+)'/);
    assertEquals(Boolean(match), true, staged);
    assertStringIncludes(await read(match![1]), 'export const local = 1');
  });

  await t.step('a type-only import is left as written', () => {
    // It is erased before the module runs, so nothing resolves it.
    assertStringIncludes(staged, `import type { Local } from '../types/local.ts'`);
  });

  await t.step('a value import after a type alias without a semicolon is still staged', async () => {
    await write(vfs, `${MOD_PATH}/demo/bin/alias-cmd`, `#!ts\nexport type Alias = number\nimport { local } from '../lib/local.ts'\nexport default local;\n`);
    assertStringIncludes(await stage(`${MOD_PATH}/demo/bin/alias-cmd`), `import { local } from 'blob:`);
  });

  await t.step('the jsr: and npm: specifiers of the whole graph are reported', async () => {
    await write(vfs, `${MOD_PATH}/other/lib/internal.ts`, `import { z } from 'npm:zod@3';\nexport const base = 42 + Number(Boolean(z));\n`);
    const { packages } = await stageUrl(`${MOD_PATH}/demo/bin/demo-cmd`);
    assertEquals(packages.toSorted(), ['jsr:@std/path@^1.1.3', 'npm:zod@3']);
    await write(vfs, `${MOD_PATH}/other/lib/internal.ts`, `export const base = 42;\n`);
  });

  await t.step('an unchanged command keeps its URL', async () => {
    // Deno caches modules by URL, so this is what keeps a re-staging from evaluating it again.
    assertEquals((await stageUrl(`${MOD_PATH}/demo/bin/demo-cmd`)).url, (await stageUrl(`${MOD_PATH}/demo/bin/demo-cmd`)).url);
  });

  await t.step('a specifier with no manifest entry is left for core to resolve', () => {
    // @ein/client comes from core's base map; making every manifest restate it would be noise.
    assertStringIncludes(staged, `from '@ein/client'`);
  });

  await t.step("a staged dependency's own imports are rewritten too", async () => {
    const match = staged.match(/import \{ thing \} from '(blob:[^']+)'/);
    const libBody = await read(match![1]);
    assertStringIncludes(libBody, `from 'blob:`);
  });

  await t.step('editing a dependency gives the command that imports it a new URL', async () => {
    // A process that has imported the command before imports the new URL afresh, and so runs the
    // edited dependency rather than the copy it evaluated first.
    const before = (await stageUrl(`${MOD_PATH}/demo/bin/demo-cmd`)).url;
    await write(vfs, `${MOD_PATH}/other/lib/shared.ts`, `export const shared = 43;\n`);

    const { url } = await stageUrl(`${MOD_PATH}/demo/bin/demo-cmd`);
    assertNotEquals(url, before);
    const restaged = await read(url);
    const match = restaged.match(/import \{ shared \} from '(blob:[^']+)'/);
    assertEquals(Boolean(match), true, restaged);
    assertStringIncludes(await read(match![1]), 'export const shared = 43');
  });

  await t.step('type-only imports may form a cycle', async () => {
    await write(vfs, `${MOD_PATH}/demo/lib/ping.ts`, `import type { Pong } from './pong.ts';\nexport type Ping = { pong?: Pong };\nexport const ping = 1;\n`);
    await write(vfs, `${MOD_PATH}/demo/lib/pong.ts`, `import type { Ping } from './ping.ts';\nexport type Pong = { ping?: Ping };\nexport const pong = 2;\n`);
    await write(vfs, `${MOD_PATH}/demo/bin/ping-cmd`, `#!ts\nimport { ping } from '../lib/ping.ts';\nexport default ping;\n`);
    const { url } = await stageUrl(`${MOD_PATH}/demo/bin/ping-cmd`);
    assertEquals((await import(url)).default, 1);
  });

  await t.step('a cycle of value imports is refused, naming the files', async () => {
    await write(vfs, `${MOD_PATH}/demo/lib/ping.ts`, `import { pong } from './pong.ts';\nexport const ping = () => pong;\n`);
    await write(vfs, `${MOD_PATH}/demo/lib/pong.ts`, `import { ping } from './ping.ts';\nexport const pong = () => ping;\n`);
    await assertRejects(
      () => stage(`${MOD_PATH}/demo/bin/ping-cmd`),
      Error,
      `import cycle in a #!ts command: ${MOD_PATH}/demo/lib/ping.ts -> ${MOD_PATH}/demo/lib/pong.ts -> ${MOD_PATH}/demo/lib/ping.ts`,
    );
  });

  await t.step('a command outside the modules path stages with no import map', async () => {
    await write(vfs, '/bin-local/loose', `#!ts\nimport { x } from './x.ts';\nexport default 0;\n`);
    await write(vfs, '/bin-local/x.ts', `export const x = 1;\n`);

    const body = await stage('/bin-local/loose');
    // No manifest, so bare specifiers are untouched — but relative ones still have to work.
    assertStringIncludes(body, `from 'blob:`);
  });
});

/** A loaded `#!ts` bin is reused until its node changes, without re-staging or re-importing it. */
Deno.test('#!ts command loading is done once per bin', async (t) => {
  const { vfs } = await createTestVfs();
  clearTsCommandCache();

  const binPath = `${MOD_PATH}/cache-demo/bin/cache-cmd`;
  const body = (n: number) => `#!ts\nexport default Object.assign(() => ${n}, { spec: { name: 'cache-cmd', description: 'n=${n}' } });\n`;

  await write(vfs, `${MOD_PATH}/cache-demo/mod.json`, JSON.stringify({ name: 'cache-demo', version: '0.1.0' }));
  await write(vfs, binPath, body(0));

  const nodeOf = () => vfs.get<FileAttrs>(ADMIN_ACCESS, binPath);
  const load = async () => await loadTsCommand(vfs, ADMIN_ACCESS, binPath, body(0), MOD_PATH, await nodeOf());

  const first = await load();

  await t.step('an unchanged bin resolves from the cache, without the vfs', async () => {
    // `cachedTsCommand` takes no vfs and is not async, so a hit cannot read the bin, its
    // mod.json, or anything it imports.
    assertStrictEquals(cachedTsCommand(MOD_PATH, binPath, await nodeOf()), first);
  });

  await t.step('a different modules path is a different command', async () => {
    // MOD_PATH decides which manifest rewrote the specifiers, so it belongs in the key.
    assertEquals(cachedTsCommand('/other-modules', binPath, await nodeOf()), undefined);
  });

  await t.step('editing the bin invalidates it', async () => {
    const handle = await vfs.open(ADMIN_ACCESS, binPath, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body(7) + '// a longer body, so size moves\n'));
    } finally {
      await handle.close();
    }

    const node = await nodeOf();
    assertEquals(cachedTsCommand(MOD_PATH, binPath, node), undefined);

    const second = await loadTsCommand(vfs, ADMIN_ACCESS, binPath, body(7), MOD_PATH, node);
    assertEquals(second === first, false);
    assertStrictEquals(cachedTsCommand(MOD_PATH, binPath, await nodeOf()), second);
  });

  await t.step('clearing drops everything', async () => {
    clearTsCommandCache();
    assertEquals(cachedTsCommand(MOD_PATH, binPath, await nodeOf()), undefined);
  });

  await t.step('a bin that does not export a CmdFunction is not cached', async () => {
    const badPath = `${MOD_PATH}/cache-demo/bin/bad-cmd`;
    await write(vfs, badPath, `#!ts\nexport default 42;\n`);
    const node = await vfs.get<FileAttrs>(ADMIN_ACCESS, badPath);

    let threw = false;
    try {
      await loadTsCommand(vfs, ADMIN_ACCESS, badPath, `#!ts\nexport default 42;\n`, MOD_PATH, node);
    } catch {
      threw = true;
    }

    assertEquals(threw, true);
    // A bin that fails to load must keep failing, not be papered over by a later good load.
    assertEquals(cachedTsCommand(MOD_PATH, badPath, node), undefined);
  });
});
