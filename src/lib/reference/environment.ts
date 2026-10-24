import type { EnvVarDoc } from './types.ts';

/**
 * The environment variables core reads, other than its settings, which `config list` already
 * describes. A `CFG_*` name read anywhere is one or the other: `docs.test.ts` holds that. Modules describe the ones they read in `mod.json` `environment`.
 *
 * A name may appear twice with different kinds: `DOCS_PATH` is a host directory to the process
 * and a tree path in a shell. `reference.test.ts` holds `PATH_DESCRIPTIONS` to the layout.
 */
export const CORE_ENVIRONMENT: EnvVarDoc[] = [
  // Deployment: the container's environment, read once by the EiN process.
  {
    key: 'POSTGRES_URL',
    kind: 'deployment',
    default: 'postgres://ein:ein@127.0.0.1:5432/ein',
    description: 'The PostgreSQL database holding the whole tree.',
  },
  {
    key: 'POSTGRES_POOL_MAX',
    kind: 'deployment',
    default: '20',
    description: 'Database connections the process may hold at once. Parallel work queues on this long before PostgreSQL itself is the limit.',
  },
  {
    key: 'POSTGRES_POOL_RESERVED',
    kind: 'deployment',
    default: '4',
    description: 'Of those, connections background work may never take, so an interactive command never waits behind a crawl. 0 is first come, first served.',
  },
  {
    key: 'POSTGRES_LISTEN_POOL_MAX',
    kind: 'deployment',
    default: '4',
    description: 'Connections kept apart for change notifications, which hold theirs for good.',
  },
  {
    key: 'FILE_ROOT_PATH',
    kind: 'deployment',
    default: './files',
    description: 'Host directory where file content is stored.',
  },
  {
    key: 'VOLATILE_FILE_ROOT_PATH',
    kind: 'deployment',
    default: 'FILE_ROOT_PATH',
    description: 'Host directory for content that can be made again — thumbnails, crops, transcodes — so it can live on a faster or cheaper disk.',
  },
  {
    key: 'FILE_TMP_PATH',
    kind: 'deployment',
    default: '/tmp',
    description: 'Host directory for temporary files while content is written.',
  },
  {
    key: 'DOCS_PATH',
    kind: 'deployment',
    default: './docs/user',
    description: 'Host directory mounted as the guide at /usr/docs/guide. In a shell the same name is the tree path /usr/docs.',
  },
  {
    key: 'DEV_MODULES_PATH',
    kind: 'deployment',
    default: './modules',
    description:
      "The deployment's modules: a folder of module checkouts mounted read-only at /tmp/dev-modules and linked into /usr/modules. A name here wins over an installed module of the same name. In a shell the same name is that tree path.",
  },
  {
    key: 'MODULE_INSTALL_PATH',
    kind: 'deployment',
    default: './modules-installed',
    description:
      'Host directory `mod install` puts modules in, mounted read-write at /var/lib/modules. A folder of the host mounted into the container keeps the installed modules when the container is replaced.',
  },
  {
    key: 'INSTALL_MODULES',
    kind: 'deployment',
    description:
      'Modules boot installs with `mod install` when they are not installed: names or repository addresses, separated by spaces. One installed already is left as it is; `mod install` and the settings page update it.',
  },
  {
    key: 'TZ',
    kind: 'deployment',
    default: "the host's zone",
    description: 'Time zone for log lines, "today", and which year a date late on New Year\'s Eve belongs to.',
  },
  {
    key: 'LOG_LEVEL',
    kind: 'deployment',
    default: 'INFO',
    description: 'How much the process logs: DEBUG, INFO, WARN or ERROR.',
  },
  {
    key: 'LOG_MODULES',
    kind: 'deployment',
    description: 'Per-component log levels over LOG_LEVEL, such as ssh-server:DEBUG,pipeline:WARN.',
  },
  {
    key: 'EXTERNAL_COMMANDS_CONFIG',
    kind: 'deployment',
    default: 'external-commands.json',
    description: 'File listing the host programs shell commands may run.',
  },
  {
    key: 'COMMAND_LOOKUP_TTL_MS',
    kind: 'deployment',
    default: '5000',
    description: 'How long a command name found on PATH is remembered before it is looked up again.',
  },
  {
    key: 'DEBUG_LOCKS',
    kind: 'deployment',
    description: 'Set to 1 to record who holds each lock and warn about one held for more than five seconds.',
  },

  // Session: set for every shell.
  { key: 'USER', kind: 'session', description: 'Your user name.' },
  { key: 'HOME', kind: 'session', description: 'Your home directory, holding your settings (.config) and shell history.' },
  {
    key: 'PATH',
    kind: 'session',
    description: "Where commands are looked up, first directory first: core's commands, then each installed module's bin directory.",
  },
  { key: 'TMPDIR', kind: 'session', description: 'Where commands put temporary nodes.' },
  { key: 'PWD', kind: 'session', description: 'The directory you are in.' },
  { key: 'OLDPWD', kind: 'session', description: 'The directory you were in before, where `cd -` goes.' },
  { key: 'UID', kind: 'session', description: 'Your user id.' },
  { key: 'GID', kind: 'session', description: "Your primary group's id." },
  { key: 'SID', kind: 'session', description: 'The session this shell belongs to.' },
  { key: 'PID', kind: 'session', description: "The running command's own id, its name and a unique suffix." },
  { key: 'TTY_NAME', kind: 'session', description: 'The terminal this shell is attached to, when it has one.' },
  { key: 'TERM', kind: 'session', description: 'The terminal type an interactive shell reports to programs.' },
  { key: 'HOSTNAME', kind: 'session', description: 'The host name shown in the prompt.' },
  { key: 'COOKIE_NAME', kind: 'session', description: 'The browser cookie that carries a web session.' },

  // System: what boot exports for scripts besides the layout.
  { key: 'INSTANCE_MODE', kind: 'system', description: 'What this process was started as: primary, or test.' },
  { key: 'ADMIN_USERNAME', kind: 'system', description: 'The built-in administrator account.' },
  { key: 'ADMIN_GROUPNAME', kind: 'system', description: 'Its group.' },
  { key: 'ADMIN_UID', kind: 'system', description: 'Its user id.' },
  { key: 'ADMIN_GID', kind: 'system', description: "Its group's id." },
  { key: 'GUEST_USERNAME', kind: 'system', description: 'The account a visitor who has not signed in acts as.' },
  { key: 'GUEST_GROUPNAME', kind: 'system', description: 'Its group.' },
  { key: 'GUEST_UID', kind: 'system', description: 'Its user id.' },
  { key: 'GUEST_GID', kind: 'system', description: "Its group's id." },
  { key: 'USERS_GROUPNAME', kind: 'system', description: 'The group every account belongs to: what "everyone" means when sharing.' },
  { key: 'USERS_GID', kind: 'system', description: 'Its id.' },
  { key: 'EIN_PATH_EXPORTS', kind: 'system', description: 'The layout variables as export lines, written into /etc/layout at boot.' },
  {
    key: 'EIN_FILE_ROOT_PATH',
    kind: 'system',
    description: 'Where file content is stored on the host, as FILE_ROOT_PATH gave it: what the dashboard reports disk use for.',
  },
  { key: 'EIN_VOLATILE_FILE_ROOT_PATH', kind: 'system', description: 'The same for content that can be made again.' },
  { key: 'EIN_FILE_TMP_PATH', kind: 'system', description: 'The same for temporary files.' },
  { key: 'EXTERNAL_FILE_ROOT_PATH', kind: 'system', description: 'FILE_ROOT_PATH as boot received it, for the init scripts.' },
  { key: 'EXTERNAL_VOLATILE_FILE_ROOT_PATH', kind: 'system', description: 'VOLATILE_FILE_ROOT_PATH as boot received it.' },
  { key: 'EXTERNAL_FILE_TMP_PATH', kind: 'system', description: 'FILE_TMP_PATH as boot received it.' },
  { key: 'EXTERNAL_DOCS_PATH', kind: 'system', description: 'DOCS_PATH as boot received it: what is mounted at /usr/docs/guide.' },
  { key: 'EXTERNAL_DEV_MODULES_PATH', kind: 'system', description: 'DEV_MODULES_PATH as boot received it.' },
  { key: 'EXTERNAL_MODULE_INSTALL_PATH', kind: 'system', description: 'MODULE_INSTALL_PATH as boot received it.' },

  // Option: export to change how a command behaves in this shell.
  {
    key: 'JSON_OUTPUT',
    kind: 'option',
    description: 'Set to 1 and commands answer in JSON instead of text. The web interface runs every command this way.',
  },
  {
    key: 'MEDIA_LINES',
    kind: 'option',
    default: '20',
    description: 'How many text lines tall `cat` draws a picture in a terminal.',
  },
  {
    key: 'SEARCH_TRACE',
    kind: 'option',
    description: 'Set to 1 and `search` reports how long each of its sources took.',
  },
  {
    key: 'CFG_PASSWORD_HASH_LOGN',
    kind: 'option',
    default: '16',
    description:
      'The scrypt work factor for new password hashes, as a power of two. Lowered by the test tier, where the passwords protect nothing; leave it unset anywhere else.',
  },

  // Pipeline: set for a step by the event that started it.
  { key: 'NODE_PATH', kind: 'pipeline', description: 'The node the event is about.' },
  { key: 'EVENT_TYPE', kind: 'pipeline', description: 'What happened, as a dotted name such as media.metadata.extracted.' },
  { key: 'EVENT_ID', kind: 'pipeline', description: "The event's id." },
  { key: 'EVENT_SOURCE', kind: 'pipeline', description: 'What raised the event, such as archive-bridge.' },
  {
    key: 'EVENT_DATA',
    kind: 'pipeline',
    description: "The event's details as JSON. Each field is also its own variable: mimetype becomes EVENT_MIMETYPE, deviceSerial EVENT_DEVICE_SERIAL.",
  },
];

/** What each layout variable from `pathEnv()` points at. */
export const PATH_DESCRIPTIONS: Record<string, string> = {
  ARCHIVE_PATH: 'The archive: everything people put in and look at.',
  TAGS_PATH: 'Labels, one directory per label holding links to what carries it.',
  HOMES_PATH: 'One home directory per user, owned by the user.',
  USERS_PATH: "The accounts: one user node per account, the administrator's.",
  ETC_PATH: 'System configuration: settings, groups, services, boot scripts.',
  GROUPS_PATH: 'Groups.',
  SERVICES_PATH: 'Service definitions.',
  INIT_FILES_PATH: 'Files installed into the tree at boot.',
  INIT_PATH: 'Boot scripts.',
  VAR_PATH: 'What the system writes as it runs.',
  LOGS_PATH: 'Logs and metrics.',
  SESSIONS_PATH: 'Open sessions.',
  LINKS_PATH: 'Share links: one node per link that opens an album without signing in.',
  QUEUES_PATH: 'Queues.',
  PIPELINE_QUEUE_PATH: 'The queue the pipeline engine works from.',
  POOLS_PATH: 'Job pools.',
  PIPELINES_PATH: 'Pipeline definitions and running instances.',
  WWW_PATH: 'Web pages served over HTTP.',
  MOD_INSTALL_PATH: 'The modules `mod install` installed, each linked into /usr/modules.',
  USR_PATH: 'Code and read-only payload.',
  BIN_PATH: 'Built-in commands.',
  LIB_PATH: "Core's other files: its shell commands, its services and the web interface.",
  MOD_PATH: 'Installed modules.',
  DOCS_PATH: 'This documentation.',
  TEMP_PATH: 'Temporary nodes.',
  DEV_MODULES_PATH: "The deployment's modules, mounted read-only.",
  VAR_DIRS: 'The directories under /var, as names separated by spaces, for boot scripts to loop over.',
};
