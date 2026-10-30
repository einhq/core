/**
 * Where module UI bundles live once `ui-build` has made them, and what the shell reads to
 * find them. Import-free: `ui-build` writes these and the browser reads them.
 */

/** Built module bundles, one directory per module, beside the manifest. */
export const UI_CACHE_PATH = '/var/cache/ui';
export const UI_MANIFEST_PATH = `${UI_CACHE_PATH}/manifest.json`;

/**
 * A module's route, as the shell patches it into its router before loading the module: its
 * path (`/devices/:id`) only. `id` keys the bundle's `routes` export, which supplies the rest
 * (`Component`, `loader`, `action`, `ErrorBoundary`, `handle`) when the route is first matched.
 */
export type ModuleRoute = { id: string; path: string };

/** A node type the Search page finds, and what its choice of what to show is called: `{ kind: 'person', label: 'People' }`. */
export type SearchableKind = { kind: string; label: string };

/** One module in the manifest. */
export type ModuleUi = {
  /** The bundle's URL (`/file/var/cache/ui/<module>/<hash>.js`). */
  url: string;
  /** Its stylesheet's, when its sources import CSS. */
  css?: string;
  routes: ModuleRoute[];
  /** Which of its routes opens a node of a type (`mod.json` `ui.open`): `{ "person": "/people/{name}" }`. */
  open?: Record<string, string>;
  /** Its node types the Search page finds (`mod.json` `nodeTypes` marked `searchable`), in their order. */
  search?: SearchableKind[];
  /**
   * The gids of the groups it is kept to (`mod groups`), when it is not everyone's: its routes are
   * a reader's when the reader is in one of them or an administrator. In the manifest only.
   */
  gids?: number[];
};

/** `/var/cache/ui/manifest.json`. */
export type UiManifest = {
  /** The id of the shell runtime the bundles were built against. */
  runtime: string;
  modules: Record<string, ModuleUi>;
};

/** `/var/cache/ui/<module>/build.json`: one module's last build, and what it was built from. */
export type ModuleBuild = ModuleUi & { key: string };
