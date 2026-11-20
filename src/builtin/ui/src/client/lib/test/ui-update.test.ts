import { assertEquals, assertNotEquals } from '@std/assert';
import type { UiManifest } from '@ui/ui-cache';
import { UI_MANIFEST_PATH } from '@ui/ui-cache';
import { manifestBundles, notePageManifest, uiChanged } from '../../signals/ui-update.ts';

const manifest = (url: string): UiManifest => ({
  runtime: 'r1',
  modules: {
    two: { url: '/file/var/cache/ui/two/b.js', routes: [] },
    one: { url, css: '/file/var/cache/ui/one/a.css', routes: [{ id: 'one/page', path: '/one' }] },
  },
});

/** A document whose module script is `src`, as far as `shellBundle` reads one. */
const fakeDocument = (src: string) => ({
  querySelector: (selector: string) => selector === 'script[type="module"][src]' ? { getAttribute: () => src } : null,
});

Deno.test('ui update: a manifest changes when a bundle does, not when what routes or who may see does', () => {
  const first = manifest('/file/var/cache/ui/one/a.js');
  assertEquals(manifestBundles(first), manifestBundles({ ...first, modules: { one: first.modules.one, two: first.modules.two } }));
  assertEquals(manifestBundles(first), manifestBundles({ ...first, modules: { ...first.modules, one: { ...first.modules.one, routes: [], gids: [100] } } }));
  assertNotEquals(manifestBundles(first), manifestBundles(manifest('/file/var/cache/ui/one/c.js')));
  assertNotEquals(manifestBundles(first), manifestBundles({ ...first, runtime: 'r2' }));
});

Deno.test('ui update: EiN changed when it serves another shell or other module bundles than the page runs', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: globalThis.fetch, document: globals.document, DOMParser: globals.DOMParser };
  let servedShell = './index-A.js';
  let servedManifest = manifest('/file/var/cache/ui/one/a.js');
  let up = true;
  globals.document = fakeDocument('./index-A.js');
  globals.DOMParser = class {
    parseFromString = (html: string) => fakeDocument(html);
  };
  globalThis.fetch = (input: string | URL | Request) => {
    const url = String(input);
    if (!up) return Promise.reject(new TypeError('failed to fetch'));
    if (url === '/') return Promise.resolve(new Response(servedShell));
    if (url === `/file${UI_MANIFEST_PATH}`) return Promise.resolve(new Response(JSON.stringify(servedManifest)));
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  try {
    // Before the page has read a manifest, only the shell is compared.
    servedManifest = manifest('/file/var/cache/ui/one/x.js');
    assertEquals(await uiChanged(), false);

    notePageManifest(manifest('/file/var/cache/ui/one/a.js'));
    // Only the first manifest read is what the page runs.
    notePageManifest(manifest('/file/var/cache/ui/one/y.js'));
    assertEquals(await uiChanged(), true);
    servedManifest = manifest('/file/var/cache/ui/one/a.js');
    assertEquals(await uiChanged(), false);

    servedShell = './index-B.js';
    assertEquals(await uiChanged(), true);

    up = false;
    assertEquals(await uiChanged(), undefined);
  } finally {
    globalThis.fetch = saved.fetch;
    globals.document = saved.document;
    globals.DOMParser = saved.DOMParser;
  }
});
