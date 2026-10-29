import type { ConfigOption } from '../lib/config/types.ts';
import type { EnvVarDoc, NodeTypeDoc } from '../lib/reference/types.ts';
import type { IndexDecl } from '../lib/contributions/types.ts';

/**
 * Module manifest schema (mod.json)
 *
 * Fields prefixed with _ are managed by the system and should not
 * be manually edited by module authors.
 */
export type ModuleManifest = {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;

  /**
   * Semver range of `@ein/client` this module is written against.
   *
   * Checked against MODULE_API_VERSION at `mod setup`. Absent means "unversioned" and is
   * accepted with a warning.
   */
  coreApi?: string;

  /**
   * The module's public interface: `./<name>` -> a file inside the module.
   *
   * Another module imports it as `@<this module>/<name>`, and only if it lists this module in
   * its `dependencies`. Nothing else in the module is reachable from outside. See
   * `src/modules/resolve.ts` for the whole rule.
   */
  exports?: Record<string, string>;

  /**
   * What the module's own code uses: private aliases into its own files (`./…`) and external
   * packages (`jsr:`, `npm:`), merged over core's base map. Never a path into another module —
   * that is what `dependencies` and the other module's `exports` are for.
   *
   * A module distributed from its own repository cannot add entries to core's `deno.jsonc`,
   * which is read once at process start — so it declares its imports here instead and the
   * loader rewrites them to absolute jsr:/npm:/file: URLs.
   */
  imports?: Record<string, string>;

  /**
   * Other modules this one needs, as name -> semver range. Verified at `mod setup`, and the
   * only modules whose `exports` this one may import or whose commands it may run.
   */
  dependencies?: Record<string, string>;

  /**
   * Settings this module owns, registered into the live option table at `mod setup`
   * and dropped again at `mod remove`.
   *
   * A module that owns a knob owns its description too: core has no business knowing
   * what a captioning VRAM floor is, and the settings UI is generated from this table,
   * so a module's options appear in it without core changing.
   *
   * The values themselves are never here — they live in `/etc/config` and
   * `$HOME/.config`. This is the label, the type, the default, and which of the
   * module's services have to be restarted when it changes.
   */
  config?: {
    options?: ConfigOption[];
  };

  /**
   * The node types this module defines, described for a reader: what `docs node-types` and the
   * documentation's node-type page say about them. A type in use but described nowhere is still
   * listed, with its count and no description. A type with a `root` is what an `@` completes to,
   * by its type.
   */
  nodeTypes?: NodeTypeDoc[];

  /**
   * Environment variables this module reads other than its `config` settings, which describe
   * themselves: what `docs env` and the documentation's environment page say about them.
   */
  environment?: EnvVarDoc[];

  /** Store indexes on this module's attrs, created at `mod setup`. */
  indexes?: IndexDecl[];

  /** The archive roots this module's content lives under (`/archive/people`), created at `mod setup`. */
  roots?: string[];

  /**
   * Browser UI contributed by this module: `routes`, each route's path with the page file that
   * draws it, relative to the module root (`{ "/devices/:id": "ui/device/pages/device.tsx" }`). The ui
   * module's `ui-build` bundles the pages from the installed module and the shell loads the
   * bundle when one of its routes is
   * first opened — as the page, in the dialog, in the drawer or full screen, which is the
   * navigation's to say: the module's `ui/nav.json`, linked by `mod setup`.
   */
  ui?: {
    routes?: Record<string, string>;
    /**
     * Which route opens a node of a type, for the shell's links to nodes it finds but does not
     * know (search results, the header's completions, the node explorer's Open):
     * `{ "person": "/people/{name}", "album": "/albums/{path}" }`, `{name}` the node's last path
     * segment and `{path}` its whole path, both URI-encoded. A type no module names is not linked.
     */
    open?: Record<string, string>;
  };
};

export const MOD_JSON_NAME = 'mod.json';

/**
 * Version of the `@ein/client` contract this core provides.
 *
 * Below 1.0.0, bump the patch for additive changes to `src/client/mod.ts` and the minor for
 * anything a module could be broken by (a caret range `^0.1.0` takes 0.1.x only). Modules
 * declare the range they accept as `coreApi`.
 */
export const MODULE_API_VERSION = '0.6.0';

/** The settings a module declares. */
export const manifestConfigOptions = (manifest: ModuleManifest): ConfigOption[] => manifest.config?.options ?? [];
