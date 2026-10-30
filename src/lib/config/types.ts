/**
 * Which file an option is written to, and who may write it.
 *
 * An option belongs to exactly one scope. That is what keeps the two layers
 * from interfering: `/etc/bashrc` sources `/etc/config` and then
 * `$HOME/.config`, so a user file *could* shadow any system key. The rule that
 * makes it safe is naming — every user-scope key is `CFG_USER_*` (the one
 * exception is `HISTSIZE`, which bash owns), and nothing a service reads is a
 * `CFG_USER_*` key. A service shell runs as admin and therefore sources
 * `/home/admin/.config`; with the rule held, there is nothing in there for it.
 */
export type ConfigScope = 'system' | 'user';

/**
 * How the settings UI renders an option and what `config set` will accept.
 *
 * `user` and `group` are names resolved against `/home` and `/etc/groups` at
 * the point of use rather than numeric ids, so the file stays readable and a
 * uid renumbering does not silently repoint a setting.
 *
 * `secret` is a key to another service, named `CFG_*_KEY`: it is kept out of
 * every shell's environment, and nothing reports its value, only whether and
 * where it is set (see `isSecretKey`).
 */
export type ConfigType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'mode'
  | 'user'
  | 'group'
  | 'secret';

export type ConfigOption = {
  /** The environment variable itself — `CFG_LANGUAGE`. */
  key: string;
  scope: ConfigScope;
  type: ConfigType;
  /** Allowed values for `type: 'select'`. */
  choices?: string[];
  /** What the consuming site falls back to. Never written to the file. */
  default: string;
  label: string;
  description: string;
  /** Section heading in the settings UI. */
  group: string;
  /**
   * Services that read this value at start and must be restarted for a change
   * to take effect.
   */
  restarts?: string[];
  /** Shown after a change, for a value that takes effect later than when `config set` returns. */
  restartNote?: string;
  /** An empty value is meaningful (e.g. "the creator") rather than unset. */
  emptyMeans?: string;
  /** Module that registered this option; absent for core's own. */
  owner?: string;
};

/**
 * Where an effective value came from, in the order they win.
 *
 * `environment` is the container's own environment, written into `/etc/environment`
 * at boot. It sits below the settings files so the UI can always override it, and above
 * `default` so clearing a setting reports what the machine will actually use
 * rather than what the table says.
 *
 * `module` is a module's own choice for a setting, its `etc/config` linked as
 * `/etc/config.d/<module>`: the assistant naming itself the search parser. Sourced
 * after the deployment's exports and before `/etc/config`, so it wins over the
 * environment and loses to anything the administrator sets.
 */
export type ConfigSource = ConfigScope | 'module' | 'environment' | 'default';

/** An option together with what it currently resolves to. */
export type ConfigEntry = ConfigOption & {
  /** The effective value across every layer. Always empty for a `secret`, whose `source` says whether it is set. */
  value: string;
  /** Which layer supplied `value`. */
  source: ConfigSource;
  /** The module whose `/etc/config.d` file supplied it, when `source` is `module`. */
  sourceModule?: string;
};
