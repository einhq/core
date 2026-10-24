/**
 * The VFS root layout — every absolute path core and the modules agree on.
 *
 * This file is the single source of truth: code imports these rather than
 * spelling a path out, and the init scripts get them as environment variables
 * (`pathEnv`).
 *
 * The layout is four regions, and the region a path belongs to is the whole
 * reason it sits where it does:
 *
 *   /archive  content — what the archive is *for*. Survives a reinstall.
 *   /home     one directory per user, theirs: staging, config, shell history.
 *   /etc      declared configuration and the accounts. Edited by a person or by `config publish`.
 *   /var      machine-owned mutable state. Rebuildable; nothing here is authored.
 *   /usr      code and read-only payload: core's commands and files, modules, the shipped guide.
 *
 * plus `/dev` (router endpoints) and `/tmp` (scratch), which keep their Unix
 * meanings exactly.
 *
 * **Keep this file a leaf.** It must import nothing. The browser shell
 * (`src/builtin/ui`) imports it, and `#!ts` bins are staged as copies where only
 * import-map aliases resolve — hence the dedicated `@ein/paths` alias rather
 * than routing this through `@ein/client`, which drags in the whole of core.
 */

/* ---------------------------------------------------------------- /archive */

/**
 * Content. Everything under here is what someone would be upset to lose; the
 * rest of the tree is reconstructible from the code and a reimport.
 */
export const ARCHIVE_PATH = '/archive';

/** The label browse tree: `<tags>/<label>/<softlink to the labelled node>`. Core's, for `label`. */
export const TAGS_ROOT = `${ARCHIVE_PATH}/tags`;

/* ------------------------------------------------------------- /home, /etc */

/** One directory per user, which the user owns: `<HOMES_PATH>/<username>`. */
export const HOMES_PATH = '/home';

/**
 * A home's mode: its owner's, and others may pass through but list nothing. What is made in it
 * takes others' bits from it (`modeUnder`), so nothing there is shared with every account, the
 * guest or a share link until its owner grants it; passing through is what lets a grant on
 * something inside reach whoever it names.
 */
export const HOME_MODE = 0o751;

/** The home of the account `username`. */
export const homePath = (username: string): string => `${HOMES_PATH}/${username}`;

/**
 * A user's trash, relative to their home directory: `<home>/.trash/<entry>/<the trashed node>`.
 * Id-to-path resolution leaves out every path inside one, so a trashed file drops out of every
 * list until it is restored or purged.
 */
export const USER_TRASH_DIR = '.trash';

/** Whether `path` lies inside some user's trash (the trash directory itself included). */
export const isTrashPath = (path: string): boolean => {
  const prefix = `${HOMES_PATH}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return false;
  const inside = rest.slice(slash + 1);
  return inside === USER_TRASH_DIR || inside.startsWith(`${USER_TRASH_DIR}/`);
};

export const ETC_PATH = '/etc';
/**
 * The accounts, the administrator's: a `user` node per account, holding its password and the link
 * to the person it is. Its user's home is `<HOMES_PATH>/<username>`.
 */
export const USERS_PATH = `${ETC_PATH}/users`;
export const GROUPS_PATH = `${ETC_PATH}/groups`;
export const SERVICES_PATH = `${ETC_PATH}/services`;
/** The init-script *sources*, mounted read-write from the repo's `src/init/files`. */
export const INIT_FILES_PATH = `${ETC_PATH}/files`;
/** The symlinks `setup.sh` runs, one per `NN_*.sh` in the mode directory. */
export const INIT_PATH = `${ETC_PATH}/init`;
/** The web UI's configuration. */
export const UI_ETC_PATH = `${ETC_PATH}/ui`;
/** `mod setup` links each module's `ui/nav.json` in here as `<name>.json`: its navigation entries. */
export const UI_NAV_D_PATH = `${UI_ETC_PATH}/nav.d`;
/** The administrator's changes to the navigation, laid over every module's. */
export const UI_NAV_PATH = `${UI_ETC_PATH}/nav.json`;
/** A user's own changes to the navigation, relative to their home directory; laid over the administrator's. */
export const USER_UI_NAV_FILE = '.ui/nav.json';

/* -------------------------------------------------------------------- /var */

/**
 * Machine-owned mutable state. Every directory below is created eagerly at boot
 * by `01_var.sh` rather than by whatever writes to it first, so `ls /var` reads
 * the same on a fresh instance as on one that has been running for a year.
 */
export const VAR_PATH = '/var';

export const LOGS_PATH = `${VAR_PATH}/logs`;
export const SYSTEM_LOG_PATH = `${LOGS_PATH}/system`;
export const METRICS_PATH = `${LOGS_PATH}/metrics`;
export const SESSIONS_PATH = `${VAR_PATH}/sessions`;
/** One `share-link` node per link that opens a node without signing in, named by its token's hash. */
export const LINKS_PATH = `${VAR_PATH}/links`;
export const QUEUES_PATH = `${VAR_PATH}/queues`;
export const PIPELINE_QUEUE_PATH = `${QUEUES_PATH}/pipeline-engine`;
export const POOLS_PATH = `${VAR_PATH}/pools`;
export const PIPELINES_PATH = `${VAR_PATH}/pipelines`;
export const PIPELINE_DEFINITIONS_PATH = `${PIPELINES_PATH}/definitions`;
export const PIPELINE_INSTANCES_PATH = `${PIPELINES_PATH}/instances`;
/** Served by the http-server service; `mod setup` links each module's `ui/` in. */
export const WWW_PATH = `${VAR_PATH}/www`;

/** Created by `01_var.sh`, in `ls /var` order. */
export const VAR_DIRS = [
  LOGS_PATH,
  PIPELINE_DEFINITIONS_PATH,
  PIPELINE_INSTANCES_PATH,
  POOLS_PATH,
  QUEUES_PATH,
  SESSIONS_PATH,
  LINKS_PATH,
  WWW_PATH,
] as const;

/* -------------------------------------------------------------------- /usr */

/** Code and read-only payload. Replaced wholesale by a deploy. */
export const USR_PATH = '/usr';

export const BIN_PATH = `${USR_PATH}/bin`;
/**
 * Core's own files that are not TypeScript commands, mounted read-only from the checkout's
 * `src/builtin`: `core/` — its bash commands, services, the `/etc/bashrc` seed and the terminal
 * page — and `ui/ui/`, the browser shell as built.
 */
export const LIB_PATH = `${USR_PATH}/lib`;
/** Early boot needs this on PATH: `mkdir` & co live here before /usr/bin mounts. */
export const CORE_BIN_PATH = `${LIB_PATH}/core/bin`;
export const MOD_PATH = `${USR_PATH}/modules`;
export const DOCS_PATH = `${USR_PATH}/docs`;
/** The shipped end-user guide, mounted read-only from the repo's `docs/user`. */
export const DOCS_GUIDE_PATH = `${DOCS_PATH}/guide`;
/** `mod setup` links each module's own docs in as `<name>`. */
export const DOCS_MODULES_PATH = `${DOCS_PATH}/modules`;

/* ------------------------------------------------------------- /dev, /tmp */

export const DEV_PATH = '/dev';
export const EVENTS_NODE_PATH = `${DEV_PATH}/events`;
export const PIPELINE_EVENTS_NODE_PATH = `${DEV_PATH}/pipeline-events`;

export const TEMP_PATH = '/tmp';
/** Development-only: the repo's `modules/` mounted read-only for `04_modules.sh`. */
export const DEV_MODULES_PATH = `${TEMP_PATH}/dev-modules`;

/* --------------------------------------------------------------------- env */

/**
 * The path variables boot exports into the shell.
 *
 * `src/init/boot.ts` writes these as `export NAME=value` lines ahead of sourcing
 * `env.sh`. `system-test-harness.ts` builds its environment from the same call,
 * so the test instance cannot drift from the primary one.
 */
export const pathEnv = (): Record<string, string> => ({
  /**
   * `CORE_BIN_PATH` has to be on PATH from the very first command: `mkdir` and
   * friends are core's bash commands, and `/usr/bin` is a command-store mount
   * that `00_mount.sh` cannot create until it can run `mkdir`. Every shell
   * after boot inherits it; `mod setup` appends the modules' bins in
   * `/etc/bashrc`.
   */
  PATH: `${BIN_PATH}:${CORE_BIN_PATH}`,
  TMPDIR: TEMP_PATH,

  ARCHIVE_PATH,
  TAGS_PATH: TAGS_ROOT,

  HOMES_PATH,
  ETC_PATH,
  USERS_PATH,
  GROUPS_PATH,
  SERVICES_PATH,
  INIT_FILES_PATH,
  INIT_PATH,

  VAR_PATH,
  LOGS_PATH,
  SESSIONS_PATH,
  LINKS_PATH,
  QUEUES_PATH,
  PIPELINE_QUEUE_PATH,
  POOLS_PATH,
  PIPELINES_PATH,
  WWW_PATH,

  USR_PATH,
  BIN_PATH,
  LIB_PATH,
  MOD_PATH,
  DOCS_PATH,

  TEMP_PATH,
  DEV_MODULES_PATH,

  /**
   * Space-separated basenames, for the init scripts to iterate rather than
   * carry their own copy of the list.
   */
  VAR_DIRS: VAR_DIRS.join(' '),
});

/**
 * The same table as `export` lines, for `09_env.sh` to write into `/etc/layout`,
 * which `/etc/bashrc` sources.
 *
 * Boot exports these into its own shell, but a shell opened later gets its
 * environment from `/etc/bashrc` alone — which is what `service start-all` and
 * a hand re-run of `setup.sh` both rely on.
 *
 * `PATH` and `TMPDIR` are deliberately left out: `mod setup` appends the module
 * bin directories to `PATH` in `/etc/bashrc`, and re-exporting it here would
 * undo them.
 */
export const pathExports = (): string =>
  Object.entries(pathEnv())
    .filter(([key]) => key !== 'PATH' && key !== 'TMPDIR')
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');

/**
 * A node's cover picture: a softlink child by this name, on an album, a person, a location or a device,
 * pointing at the media that stands for it. Not a member of anything it sits in. Read and set it
 * with `readCoverTarget`/`setCover` from `@ein/client`.
 */
export const COVER_LINK_NAME = 'coverPhoto';

/**
 * An album's neighbours in a series of albums: softlink children by these names, each pointing at
 * the album before or after it. Not members of the album they sit in.
 */
export const PREVIOUS_LINK_NAME = 'previous';
export const NEXT_LINK_NAME = 'next';

/** The softlink children that say something about the node they sit in, rather than file a member in it. */
export const NON_MEMBER_LINK_NAMES: readonly string[] = [COVER_LINK_NAME, PREVIOUS_LINK_NAME, NEXT_LINK_NAME];
