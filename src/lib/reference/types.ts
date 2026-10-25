/**
 * What the documentation says about the parts of an installation that are not commands or
 * settings: its node types and its environment variables.
 *
 * Commands describe themselves (`CmdSpec`) and settings are described where they are registered
 * (`ConfigOption`); a node type is a free-form string and an environment variable is read
 * wherever it is needed, so neither has a location of its own. Core describes its own here
 * (`node-types.ts`, `environment.ts`), and a module describes its own in `mod.json` under the
 * same shapes, so `docs node-types` and `docs env` answer for whatever is installed.
 */

/** Where a node type sits: what the archive is made of, how it is arranged, or how it runs. */
export type NodeTypeCategory = 'content' | 'structure' | 'system';

export type NodeTypeDoc = {
  /** The `type` string on the node — `album`. */
  type: string;
  /** What a reader calls it — "Album". */
  label: string;
  description: string;
  category: NodeTypeCategory;
  /**
   * The folder the type's nodes live directly under (`/archive/people`). A type with a root is
   * what an `@` completes to.
   */
  root?: string;
  /**
   * The Search page finds nodes of this type and offers it as a choice of what to show. Needs a
   * `root`, and a type the `search` command knows (`--kind`).
   */
  searchable?: boolean;
  /** What a reader calls several of them — "People"; the label with an `s` when not given. */
  plural?: string;
};

/**
 * How a variable reaches whatever reads it.
 *
 * - `deployment`: the EiN process's own environment, read once at start. Not in any shell, and
 *   never echoed back: `POSTGRES_URL` carries the database password.
 * - `session`: set for every shell by the server that opened it.
 * - `path`: the tree's layout, exported into `/etc/bashrc` at boot.
 * - `system`: the rest of what boot exports for scripts: the built-in accounts, the host
 *   directories the tiers are on.
 * - `option`: nobody sets it for you; export it in a shell to change how a command behaves there.
 * - `pipeline`: set for a pipeline step by the event that started it.
 */
export type EnvVarKind = 'deployment' | 'session' | 'path' | 'system' | 'option' | 'pipeline';

export type EnvVarDoc = {
  key: string;
  kind: EnvVarKind;
  description: string;
  /** What the reader falls back to when it is unset. */
  default?: string;
};

/** A description as `docs` reports it: with the module that declared it, absent for core's own. */
export type Owned<T> = T & { owner?: string };
