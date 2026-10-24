/**
 * `ui-build` bundles a module's pages from the VFS: a fixture module written there, built,
 * then loaded the way the browser loads it — against a global holding what the shell lends.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient } from '@ein/testing';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToString } from 'react-dom/server';
import type { UiManifest } from '@ui/ui-cache';

const testCtx = createTestContext();

/**
 * An import line of a fixture source, put together at runtime: written out whole, the module
 * boundary test would read the fixture's imports as this file's own.
 */
const imp = (what: string, spec: string): string => `import ${what} ${'from'} ${JSON.stringify(spec)};`;

type Outcome = { state: string; error?: string };

Deno.test({ name: 'ui-build', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const modules = `${(await client.exec('echo $MOD_PATH')).data}`.trim();
  const root = `${modules}/uifix`;

  const put = async (path: string, text: string) => {
    await client.exec(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))}`);
    if (!await vfs.exists(ADMIN_ACCESS, path)) {
      await vfs.create(ADMIN_ACCESS, 'file', path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1));
    }
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(text));
    } finally {
      await handle.close();
    }
  };
  const read = async (path: string): Promise<string> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return await new Response(handle.readable).text();
    } finally {
      await handle.close();
    }
  };
  const build = async (args: string): Promise<Record<string, Outcome>> => {
    const result = await client.exec(`ui-build ${args}`);
    // A failed build exits 1, and the API shell then hands its stdout back as `output`.
    const answer = result.success ? result.data : JSON.parse((result.rawResponse as { output: string }).output);
    return (answer as { modules: Record<string, Outcome> }).modules;
  };

  const routes: Record<string, string> = { '/things': 'ui/pages/things.tsx', '/things/:id': 'ui/pages/thing.tsx' };
  const putModJson = (name: string, extra: Record<string, string> = {}) =>
    put(
      `${modules}/${name}/mod.json`,
      JSON.stringify({
        name,
        version: '0.1.0',
        imports: { [`@${name}/greet`]: './lib/greet.ts' },
        exports: { './api': './lib/api.ts' },
        ui: { routes: { ...routes, ...extra } },
      }),
    );

  try {
    await putModJson('uifix');
    await put(`${root}/lib/greet.ts`, 'export const greet = (name: string): string => `Hello ${name}`;\n');
    await put(`${root}/lib/api.ts`, `import type { Node } from '@ein/client';\nexport type Thing = { name: string; node?: Node };\n`);
    await put(
      `${root}/ui/pages/things.tsx`,
      [
        imp('type { Thing }', '@uifix/api'),
        imp('{ greet }', '@uifix/greet'),
        imp('{ Text }', '@mantine/core'),
        imp('styles', './things.module.css'),
        `export const handle = { fullBleed: true };`,
        `export default function Things() {`,
        `  const thing: Thing = { name: 'Anna Andersson' };`,
        `  return <Text className={styles.title}>{greet(thing.name)}</Text>;`,
        `}`,
      ].join('\n'),
    );
    await put(`${root}/ui/pages/things.module.css`, '.title { color: red; }\n');
    await put(
      `${root}/ui/pages/thing.tsx`,
      `${imp('{ useParams }', 'react-router-dom')}\nexport const loader = () => 'seven';\nexport default function Thing() {\n  return <p>{useParams().id}</p>;\n}\n`,
    );

    let manifest: UiManifest | undefined;

    await t.step('builds, and lists the routes in the manifest', async () => {
      const outcome = (await build('uifix')).uifix;
      assertEquals(outcome.state, 'built', outcome.error);
      manifest = JSON.parse(await read('/var/cache/ui/manifest.json')) as UiManifest;
      assertEquals(manifest.modules.uifix.routes, [{ id: 'uifix:/things', path: '/things' }, { id: 'uifix:/things/:id', path: '/things/:id' }]);
      const node = await vfs.get(ADMIN_ACCESS, manifest.modules.uifix.url.replace(/^\/file/, ''));
      assertEquals(node.attrs.mimetype, 'text/javascript');
      assertEquals(node.attrs.immutable, true);
    });

    await t.step('its CSS modules carry the module name', async () => {
      const css = await read(manifest!.modules.uifix.css!.replace(/^\/file/, ''));
      assertStringIncludes(css, 'uifix_things_title');
    });

    await t.step('the bundle runs against what the shell lends', async () => {
      const stub = (names: string[]) => Object.fromEntries(names.map((name) => [name, () => null]));
      (globalThis as Record<string, unknown>).__EIN_UI__ = {
        'react': React,
        'react/jsx-runtime': jsxRuntime,
        'react-dom': {},
        'react-router-dom': { ...stub(['Outlet']), useParams: () => ({ id: '7' }) },
        '@mantine/core': { Text: (props: { className?: string; children?: unknown }) => React.createElement('span', props as never) },
        '@mantine/hooks': {},
        '@preact/signals-react': {},
        '@preact/signals-react/runtime': {},
        '@ein/paths': {},
        '@ein/ui/components': {},
        '@ein/ui/hooks': {},
        '@ein/ui/lib': {},
        '@ein/ui/signals': {},
        '@ein/ui/theme': {},
      };
      const file = await Deno.makeTempFile({ suffix: '.js' });
      try {
        await Deno.writeTextFile(file, await read(manifest!.modules.uifix.url.replace(/^\/file/, '')));
        const bundle = await import(`file://${file}`) as {
          routes: Record<string, { Component: () => unknown; handle?: { fullBleed?: boolean }; loader?: () => unknown }>;
        };
        const things = bundle.routes['uifix:/things'];
        const html = renderToString(React.createElement(things.Component as never));
        assertStringIncludes(html, 'Hello Anna Andersson');
        assertStringIncludes(html, 'uifix_things_title');
        assertEquals(things.handle?.fullBleed, true);
        // What a page does not export is not the route's, not even as undefined.
        assertEquals(Object.keys(things).sort(), ['Component', 'handle']);
        const thing = bundle.routes['uifix:/things/:id'];
        assertEquals(renderToString(React.createElement(thing.Component as never)), '<p>7</p>');
        assertEquals(thing.loader?.(), 'seven');
      } finally {
        await Deno.remove(file);
        delete (globalThis as Record<string, unknown>).__EIN_UI__;
      }
    });

    await t.step('an unchanged module is not rebuilt', async () => {
      assertEquals((await build('uifix')).uifix.state, 'cached');
      assertEquals((await build('--all')).uifix.state, 'cached');
    });

    await t.step('a route may sit under a shell route', async () => {
      // The shell has /albums and /albums/:id; /albums/fixture beside them is the module's.
      await putModJson('uifix', { '/albums/fixture': 'ui/pages/new-album.tsx' });
      await put(`${root}/ui/pages/new-album.tsx`, `export default function NewThing() {\n  return <p />;\n}\n`);
      const beside = (await build('uifix')).uifix;
      assertEquals(beside.state, 'built', beside.error);
      const routes = (JSON.parse(await read('/var/cache/ui/manifest.json')) as UiManifest).modules.uifix.routes;
      assertEquals(routes.find((route) => route.path === '/albums/fixture'), { id: 'uifix:/albums/fixture', path: '/albums/fixture' });
    });

    await t.step('a page may not bring a package', async () => {
      await put(`${root}/ui/pages/extra.tsx`, `${imp('dayjs', 'dayjs')}\nexport const d = dayjs;\n`);
      await put(`${root}/ui/pages/thing.tsx`, `${imp('{ d }', './extra.tsx')}\nexport default function Thing() {\n  return <p>{String(d)}</p>;\n}\n`);
      const outcome = (await build('uifix')).uifix;
      assertEquals(outcome.state, 'failed');
      assert(outcome.error?.includes(`'dayjs' is neither lent by the shell nor the module's own`), outcome.error);
      await put(`${root}/ui/pages/thing.tsx`, `export default function Thing() {\n  return <p />;\n}\n`);
    });

    await t.step('a route is a path of literal and :param segments', async () => {
      await putModJson('uifix', { '/things/[id]': 'ui/pages/thing.tsx' });
      const outcome = (await build('uifix')).uifix;
      assertEquals(outcome.state, 'failed');
      assertStringIncludes(outcome.error ?? '', `'/things/[id]' is not a path below '/'`);
      await putModJson('uifix');
      assertEquals((await build('uifix')).uifix.state, 'built');
    });

    await t.step("a path is one module's", async () => {
      // uifix2 sorts after uifix, so it is the one left out.
      await putModJson('uifix2');
      for (const file of ['lib/greet.ts', 'lib/api.ts', 'ui/pages/things.tsx', 'ui/pages/things.module.css', 'ui/pages/thing.tsx']) {
        await put(`${modules}/uifix2/${file}`, (await read(`${root}/${file}`)).replaceAll('@uifix/', '@uifix2/'));
      }
      const outcomes = await build('uifix2');
      assertEquals(outcomes.uifix2, { state: 'failed', error: `/things is uifix's route already` });
      const listed = (JSON.parse(await read('/var/cache/ui/manifest.json')) as UiManifest).modules;
      assertEquals(['uifix' in listed, 'uifix2' in listed], [true, false]);
      await client.exec(`rm -rf ${modules}/uifix2`);
    });

    await t.step('--all forgets a module that is gone', async () => {
      await client.exec(`rm -rf ${root}`);
      // Other installed modules may have pages of their own; the fixture is what has to be gone.
      assertEquals('uifix' in await build('--all'), false);
      assertEquals('uifix' in (JSON.parse(await read('/var/cache/ui/manifest.json')) as UiManifest).modules, false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/var/cache/ui/uifix'), false);
    });
  } finally {
    await testCtx.teardown();
  }
});
