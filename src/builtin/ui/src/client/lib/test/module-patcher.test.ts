import { assertEquals } from '@std/assert';
import type { UiManifest } from '@ui/ui-cache';
import { uiRuntime } from '@ui/shared';
import { createMemoryRouter } from 'react-router-dom';
import { awaitModuleRoutes, loadModuleBundle, modulePatcher, nodeRoutes, reloadUiManifest } from '../../signals/module-ui.ts';

/** A module whose bundle is a data URL with one route, `<name>/page` at `/<name>`. */
const moduleUi = (name: string) => ({
  url: `data:text/javascript,export const routes = { "${name}/page": {} };`,
  routes: [{ id: `${name}/page`, path: `/${name}` }],
  open: { [name]: `/${name}` },
});

let manifest: UiManifest = { runtime: uiRuntime().id, modules: { one: moduleUi('one') } };

const matchedRoute = (router: ReturnType<typeof createMemoryRouter>): string | undefined => router.state.matches.at(-1)?.route.id;

Deno.test('module routes: a module installed after the manifest was read is routed once it is read again', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(manifest)));
  try {
    const router = createMemoryRouter(
      [{ id: 'root', path: '/', ...awaitModuleRoutes, children: [{ id: 'missing', path: '*' }] }],
      { patchRoutesOnNavigation: modulePatcher() },
    );
    router.initialize();
    await router.navigate('/one');
    assertEquals(matchedRoute(router), 'one/page');

    manifest = { ...manifest, modules: { ...manifest.modules, two: moduleUi('two') } };
    await reloadUiManifest();
    assertEquals(nodeRoutes.value, { one: '/one', two: '/two' });
    await router.navigate('/two');
    assertEquals(matchedRoute(router), 'two/page');
    // The first module's routes are not added twice.
    assertEquals(router.routes[0].children?.map((route) => route.id), ['missing', 'one/page', 'two/page']);

    // A removed module's bundle is no longer found.
    manifest = { ...manifest, modules: { one: moduleUi('one') } };
    await reloadUiManifest();
    assertEquals(nodeRoutes.value, { one: '/one' });
    assertEquals(await loadModuleBundle('two').then(() => 'loaded', (error: Error) => error.message), 'module two has no UI');
    router.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
});
