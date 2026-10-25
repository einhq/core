import { signal } from '@preact/signals-react';
import { uiRuntime } from '@ui/shared';
import type { ModuleRoute, SearchableKind, UiManifest } from '@ui/ui-cache';
import { UI_MANIFEST_PATH } from '@ui/ui-cache';
import { ModuleLoadError } from '../lib/module-load-error.ts';
import { type DataRouter, type Location, matchPath, matchRoutes, type NavigationType, type RouteObject, type To } from 'react-router-dom';

/**
 * Module routes, loaded from the bundles `ui-build` makes of each module's `ui.routes`
 * (src/builtin/ui/lib/module-build.ts). The manifest says which routes each module has, so a
 * router can match them before any module's code has loaded; a module's bundle — and its
 * stylesheet, first — loads when one of its routes is first matched, on the page, in the
 * dialog, in the drawer or full screen. The bundles read React, Mantine and the kit from the shell
 * (`globalThis.__EIN_UI__`, set by `lend.ts` before anything here runs).
 */

/** What a module bundle exports: each route's parts by route id. */
export type ModuleBundle = {
  routes: Record<string, Record<string, unknown>>;
};

let shellRoutes: RouteObject[] = [];
let pageRouter: DataRouter | undefined;

/**
 * The entry hands over the shell's route table and the page's router: the dialog, the drawer
 * and the full-screen surface render routes from the same table, and send a navigation that
 * leaves them to the page.
 */
export const registerShellRouting = (routes: RouteObject[], router: DataRouter): void => {
  shellRoutes = routes;
  pageRouter = router;
};

/** The shell's routes below its root (the root itself is the app's frame). */
export const shellChildRoutes = (): RouteObject[] => shellRoutes[0]?.children ?? [];

/** Open a location as the page, or step through its history (`-1`). */
export const navigatePage = (to: To | number, options?: { replace?: boolean; state?: unknown }): void => {
  if (typeof to === 'number') void pageRouter?.navigate(to);
  else void pageRouter?.navigate(to, options);
};

/** Where the page is, for code outside its router: a surface, or the chat in the drawer. */
export const pageLocation = (): Location | undefined => pageRouter?.state.location;

/** Whether the page is on its way to another location, not yet there. */
export const pageNavigating = (): boolean => pageRouter !== undefined && pageRouter.state.navigation.state !== 'idle';

/** Hear each change of the page's router state, and how its location was come to; returns the unsubscribe. */
export const onPageChange = (listener: (location: Location, action: NavigationType) => void): () => void =>
  pageRouter?.subscribe((state) => listener(state.location, state.historyAction)) ?? (() => {});

/**
 * Which route opens a node of a type, from every module's `ui.open`: the shell links what it
 * finds — search results, the header's completions, the explorer's Open — without knowing whose
 * pages those are. Filled when the manifest is read.
 */
export const nodeRoutes = signal<Record<string, string>>({});

/** The route that opens a node, or null when no installed module gives one for its type. */
export const openRoute = (type: string, path: string): string | null => {
  const template = nodeRoutes.value[type];
  if (!template) return null;
  const segments = path.split('/');
  return template
    .replaceAll('{path}', encodeURIComponent(path))
    .replaceAll('{name}', encodeURIComponent(segments.at(-1) ?? ''))
    .replaceAll('{parent}', encodeURIComponent(segments.at(-2) ?? ''));
};

/**
 * The node types the Search page finds, from every module's `nodeTypes` marked `searchable`, in
 * module order: what it searches for and offers as choices of what to show. Filled when the
 * manifest is read; empty when no installed module has any.
 */
export const searchableKinds = signal<SearchableKind[]>([]);

/** The paths the installed modules route, as they write them (`/media`, `/people/:name`); filled when the manifest is read. */
export const moduleRoutePaths = signal<ReadonlySet<string>>(new Set());

let manifestPromise: Promise<UiManifest | null> | null = null;

/**
 * The manifest, fetched once. A failed fetch is forgotten so the next call tries again:
 * before signing in, a guest may not be able to read it.
 */
export const loadUiManifest = (): Promise<UiManifest | null> => {
  manifestPromise ??= fetch(`/file${UI_MANIFEST_PATH}`, { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() as Promise<UiManifest> : null))
    .catch(() => null)
    .then((manifest) => {
      if (!manifest) manifestPromise = null;
      // Bundles built against another shell read names this one may not lend. ui-build
      // rebuilds them at every boot, so this is a shell deployed without restarting EiN.
      const runtime = uiRuntime().id;
      if (manifest) nodeRoutes.value = Object.assign({}, ...Object.values(manifest.modules).map((entry) => entry.open ?? {}));
      if (manifest) moduleRoutePaths.value = new Set(Object.values(manifest.modules).flatMap((entry) => entry.routes.map((route) => route.path)));
      if (manifest) searchableKinds.value = Object.values(manifest.modules).flatMap((entry) => entry.search ?? []);
      if (manifest && manifest.runtime !== runtime) {
        console.warn(`module bundles were built for UI runtime ${manifest.runtime}, this shell is ${runtime}: run ui-build --all`);
      }
      return manifest;
    });
  return manifestPromise;
};

/** Resolves once the stylesheet has loaded (or failed to): a page is never drawn unstyled. */
const loadStylesheet = (href: string): Promise<void> =>
  new Promise((resolve) => {
    if (document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });

const bundles = new Map<string, Promise<ModuleBundle>>();

/** A module's bundle, loaded once. */
export const loadModuleBundle = (module: string): Promise<ModuleBundle> => {
  let bundle = bundles.get(module);
  if (!bundle) {
    bundle = (async () => {
      const entry = (await loadUiManifest())?.modules[module];
      if (!entry) throw new Error(`module ${module} has no UI`);
      if (entry.css) await loadStylesheet(entry.css);
      return await import(entry.url) as ModuleBundle;
    })();
    // A failed load (a deploy replaced the bundle under an open page) is tried again next time.
    bundle.catch(() => bundles.delete(module));
    bundles.set(module, bundle);
  }
  return bundle;
};

/** The full pattern of the shell route a path matches (`/docs/commands`), if any. */
const shellPattern = (path: string): string | undefined => {
  const matches = matchRoutes(shellRoutes, path);
  if (!matches) return undefined;
  return `/${matches.map((match) => (match.route.path ?? '').replace(/^\/|\/$/g, '')).filter(Boolean).join('/')}`;
};

/** A manifest route as a child of the root, its parts loaded with the module's bundle. */
const toRoute = (module: string, route: ModuleRoute): RouteObject => ({
  id: route.id,
  path: route.path.slice(1),
  lazy: async () => {
    try {
      return (await loadModuleBundle(module)).routes[route.id] ?? {};
    } catch (error) {
      throw new ModuleLoadError(module, error);
    }
  },
});

/**
 * Start loading the bundle of the module whose route this is, without waiting: the
 * navigation does it for the routes its entries open, so that a dialog's first opening does
 * not wait behind whatever the page is downloading.
 */
export const prefetchRoute = async (path: string): Promise<void> => {
  const manifest = await loadUiManifest();
  const pathname = path.split(/[?#]/)[0];
  for (const [module, entry] of Object.entries(manifest?.modules ?? {})) {
    if (entry.routes.some((route) => matchPath(route.path, pathname))) await loadModuleBundle(module).catch(() => undefined);
  }
};

/**
 * Spread into the root route of a router that patches in module routes. Until the patcher has run,
 * react-router draws the shell routes that match the start of a module's path (`/system` for
 * `/system/gpu`): the wrong page, and for a panel on that page — the dashboard's GPU panel — the
 * page again inside its own panel, without end. A root loader that has not run yet makes it draw
 * the root's `HydrateFallback` instead. The loader loads nothing, and never runs again.
 */
export const awaitModuleRoutes = { loader: () => null, shouldRevalidate: () => false };

/**
 * A router's `patchRoutesOnNavigation`, one per router (the page's and each surface's): called
 * when a path matches none of its routes, it adds every module's routes under the root once, and the router matches again. Before the manifest can be read (signed
 * out) it adds nothing and is asked again next time.
 */
export const modulePatcher = () => {
  let patched = false;
  return async ({ patch }: { patch: (routeId: string | null, children: never[]) => void }): Promise<void> => {
    if (patched) return;
    const manifest = await loadUiManifest();
    if (!manifest || patched) return;
    patched = true;
    for (const [module, entry] of Object.entries(manifest.modules)) {
      for (const route of entry.routes) {
        if (shellPattern(route.path) === route.path) console.warn(`${module}'s route ${route.path} is the shell's own, which is matched instead`);
      }
      patch('root', entry.routes.map((route) => toRoute(module, route)) as never[]);
    }
  };
};
