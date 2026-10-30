import { NAME_LANGUAGES } from '../../vfs/query.ts';
import type { ConfigOption } from './types.ts';

/**
 * Core's own configuration options.
 *
 * A module declares its options in its `mod.json` instead, and `mod setup`
 * registers them into the same table — so `ems`'s service address and
 * archive's worker capacities stay with their owners. See `registry.ts`.
 *
 * The table holds no values. It is the label/validation/restart map: what a
 * key is called in plain language, what `config set` will accept for it, and
 * which services read it at start and therefore have to be restarted for a
 * change to land. The values live in `/etc/config` and `$HOME/.config`.
 */
export const CORE_OPTIONS: ConfigOption[] = [
  /* Language */
  {
    key: 'CFG_LANGUAGE',
    scope: 'system',
    type: 'select',
    choices: [...NAME_LANGUAGES],
    default: 'en',
    label: 'Archive language',
    description: 'The language the archive is kept in: the order names are sorted in, the words it offers as labels, and how it describes how two people are related.',
    group: 'Language',
  },

  /* Sessions */
  {
    key: 'CFG_SESSION_MAX_AGE_SEC',
    scope: 'system',
    type: 'number',
    default: '86400',
    label: 'Session cookie lifetime',
    description: 'How long a browser keeps its session cookie. Refreshed on every navigation, so this bounds idleness rather than total session age.',
    group: 'Sessions',
  },
  {
    key: 'CFG_SESSION_EXPIRES_SEC',
    scope: 'system',
    type: 'number',
    default: '43200',
    label: 'Session expiry',
    description:
      'How long after its last activity a session is collected by the reaper. A session keeps the value it was created with; one holding an open terminal is never collected, whatever this says.',
    group: 'Sessions',
  },
  {
    key: 'CFG_TERMINAL_RECONNECT_GRACE_SEC',
    scope: 'system',
    type: 'number',
    default: '300',
    label: 'Terminal reconnect grace',
    description:
      'How long an interactive terminal survives without a browser connection, allowing reloads and short network interruptions to reattach. A change applies from the next disconnect.',
    group: 'Sessions',
  },
  {
    key: 'CFG_SESSION_REAP_INTERVAL',
    scope: 'system',
    type: 'number',
    default: '3600',
    label: 'Session cleanup interval (seconds)',
    description: 'How often expired sessions and stranded terminals are collected, and expired share links turned off.',
    group: 'Sessions',
    restarts: ['session-reaper'],
  },

  /* Processing */
  {
    key: 'CFG_PIPELINE_MAX_CONCURRENT',
    scope: 'system',
    type: 'number',
    default: '4',
    label: 'Pipeline steps in parallel',
    description: 'How many inline pipeline steps the engine runs at once. Steps that are GPU- or CPU-heavy go to a worker pool instead and are bounded separately.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_STEP_QUIET_MS',
    scope: 'system',
    type: 'number',
    default: '1800000',
    label: 'Quiet step warning (ms)',
    description:
      'How long a running pipeline step may go without writing any output before the pipeline overview flags it. A flagged step keeps running: no step is ever stopped for taking long.',
    group: 'Processing',
  },
  {
    key: 'CFG_PIPELINE_TRIGGER_CONCURRENCY',
    scope: 'system',
    type: 'number',
    default: '4',
    label: 'Trigger concurrency',
    description: 'How many pipeline triggers the engine evaluates at once against incoming VFS events.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_CONSUME_CONCURRENCY',
    scope: 'system',
    type: 'number',
    default: '4',
    label: 'Queue consume concurrency',
    description: 'How many queue entries the engine consumes in parallel.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_ENTRY_ADMISSION_PERCENT',
    scope: 'system',
    type: 'number',
    default: '0',
    label: 'Entry pipeline reservation (%)',
    description: 'Share of trigger claims that first try pipelines declaring options.entryPoint. Empty reserved claims fall back to the ordinary fair rotation.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_MAX_ADMITTED_STEPS',
    scope: 'system',
    type: 'number',
    default: '',
    emptyMeans: '25 × pipeline steps in parallel',
    label: 'Steps held in flight',
    description:
      'How many dispatched steps the engine holds in memory before it stops claiming triggers. Work beyond it waits in the pool, where it costs nothing. Empty means 25 times the pipeline steps in parallel.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_MAX_OPEN_INSTANCES',
    scope: 'system',
    type: 'number',
    default: '5000',
    label: 'Pipeline instances held open',
    description:
      'How many pipeline instances the engine holds open at once, including those waiting on a worker pool. Every stuck sweep re-advances each open instance, so raise it together with the sweep interval.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_STUCK_SWEEP_MS',
    scope: 'system',
    type: 'number',
    default: '60000',
    label: 'Stuck sweep interval (ms)',
    description:
      'How often, at most, the engine re-advances its open instances to repair any that stopped without finishing, and how long it backs off while admission is full.',
    group: 'Processing',
    restarts: ['pipeline-engine'],
  },
  {
    key: 'CFG_PIPELINE_KIND_QUANTUM_MS',
    scope: 'system',
    type: 'number',
    default: '0',
    label: 'Worker backlog rotation (ms)',
    description:
      'How long a pipeline worker that serves several kinds of job stays on one before rotating to the next when work remains on both. 0 always takes the highest-priority kind. Applies to workers whose service does not set its own rotation.',
    group: 'Processing',
    restartNote: 'Read by each pipeline worker when it starts: restart the services that run one.',
  },
  {
    key: 'CFG_PIPELINE_PRUNE_INTERVAL',
    scope: 'system',
    type: 'number',
    default: '3600',
    label: 'Pipeline cleanup interval (seconds)',
    description: 'How often finished pipeline instances are pruned.',
    group: 'Processing',
    restarts: ['pipeline-pruner'],
  },

  /* Users and sharing */
  {
    key: 'CFG_DEFAULT_USER_GROUPS',
    scope: 'system',
    type: 'string',
    default: 'users',
    emptyMeans: 'no groups besides their own',
    label: 'Default groups for new users',
    description:
      'The groups a new account joins besides its own, as a comma-separated list of names. The New user form starts with them ticked, and user-create takes them unless --groups names others.',
    group: 'Users and sharing',
  },
  {
    key: 'CFG_DEFAULT_SHARE_MODE',
    scope: 'system',
    type: 'mode',
    default: '0750',
    label: 'Default permissions',
    description:
      'Who may see and who may change anything created as shared: its owner, its group and everyone else, each with no access, view or edit. Everyone else is visitors who are not signed in, where they may browse, and anyone with an account outside the group. Kept as an octal mode, as in 0750.',
    group: 'Users and sharing',
  },
  {
    key: 'CFG_DEFAULT_SHARE_OWNER',
    scope: 'system',
    type: 'user',
    default: '',
    emptyMeans: 'the person who creates it',
    label: 'Default owner',
    description: "Who owns anything created as shared; a private album stays its creator's. Leave empty to let whoever creates it own it.",
    group: 'Users and sharing',
  },
  {
    key: 'CFG_DEFAULT_SHARE_GROUP',
    scope: 'system',
    type: 'group',
    default: 'users',
    emptyMeans: "the creator's primary group",
    label: 'Default group',
    description: 'The group anything created as shared belongs to. This is the grant that lets the rest of the household see it.',
    group: 'Users and sharing',
  },
  {
    key: 'CFG_GUEST_BROWSING',
    scope: 'system',
    type: 'boolean',
    default: 'false',
    label: 'Visitors may browse',
    description:
      "Whether someone who has not signed in may browse the archive as the guest, seeing what is shared with visitors, rather than being asked to sign in. Off, the guest can only sign in or open a share link, in the web interface and through the API alike. Only on does the assistant's language model answer them. Off for a family's own archive; on for a public demo.",
    group: 'Users and sharing',
  },

  /* Search — which command does a job only one may do. A module names itself in its own
     `etc/config` (linked as /etc/config.d/<module>); a value set here wins over it. */
  {
    key: 'CFG_SEARCH_PARSER',
    scope: 'system',
    type: 'string',
    default: '',
    label: 'Search parser',
    description:
      'The command that reads what is typed into the search box as filters — people, locations, years, kinds. Empty searches the words as they are. Archive sets its parser here when it is installed.',
    group: 'Search',
    emptyMeans: 'the words as they are',
  },
  {
    key: 'CFG_COMMAND_FINDER',
    scope: 'system',
    type: 'string',
    default: '',
    label: 'Command finder',
    description:
      "The command that finds shell commands by what they are for, in the documentation's command search. Empty matches the words against command names and descriptions. The assistant sets itself here when it is installed.",
    group: 'Search',
    emptyMeans: 'a match on names and descriptions',
  },
  {
    key: 'CFG_LANGUAGE_MODEL',
    scope: 'system',
    type: 'string',
    default: '',
    label: 'Language model command',
    description:
      "The command that asks a language model, for reading what a person writes as they write it — the search box's parser reads people, locations and words with it. Empty asks no model. The assistant sets itself here when it is installed.",
    group: 'Search',
    emptyMeans: 'no model',
  },
  {
    key: 'CFG_TEXT_EMBEDDER',
    scope: 'system',
    type: 'string',
    default: '',
    label: 'Text embedder',
    description:
      'The command that turns texts into vectors, for finding by meaning — the command finder ranks commands with it. Empty finds by words alone. The media service sets itself here when it is installed.',
    group: 'Search',
    emptyMeans: 'by words alone',
  },

  /* Modules — where `mod search`, `mod install` and the Modules settings find the published ones. */
  {
    key: 'CFG_MODULE_SOURCES',
    scope: 'system',
    type: 'string',
    default: 'https://github.com/einhq',
    label: 'Module sources',
    description:
      "Where published modules are looked for: organisations on GitHub, Forgejo or Gitea, as their addresses separated by spaces, such as https://github.com/einhq. Each repository named module-<name> in them is a module. A module installed by name comes from the first source that has it, and a module's dependencies from its own organisation first.",
    group: 'Modules',
    emptyMeans: 'none: modules are installed by their repository address',
  },
  {
    key: 'CFG_MODULE_SOURCES_KEY',
    scope: 'system',
    type: 'secret',
    default: '',
    label: 'Tokens for module sources',
    description:
      'Access tokens for module sources that are not public, as host=token separated by spaces, such as forge.example:3000=… github.com=…. Each token is sent to its own host only.',
    group: 'Modules',
  },

  /* Network — neither of these can restart its own service from here. */
  {
    key: 'CFG_HTTP_PORT',
    scope: 'system',
    type: 'number',
    default: '8080',
    label: 'HTTP port',
    description: 'The port the web interface listens on.',
    group: 'Network',
    restartNote: 'Takes effect the next time the server starts — restarting it from here would drop this connection.',
  },
  {
    key: 'CFG_SSH_PORT',
    scope: 'system',
    type: 'number',
    default: '2222',
    label: 'SSH port',
    description: 'The port the SSH and SFTP server listens on.',
    group: 'Network',
    restartNote: 'Takes effect the next time the server starts.',
  },

  /* Trash and /tmp */
  {
    key: 'CFG_TRASH_RETENTION_DAYS',
    scope: 'system',
    type: 'number',
    default: '30',
    label: 'Days in the trash',
    description: 'How long a trashed file stays restorable before it is removed for good.',
    group: 'Trash',
    restarts: ['trash-purger'],
  },
  {
    key: 'CFG_TMP_RETENTION_HOURS',
    scope: 'system',
    type: 'number',
    default: '24',
    label: 'Hours in /tmp',
    description: 'How long a file left in /tmp, such as a picture sent to search with, is kept before it is removed.',
    group: 'Storage',
    restarts: ['tmp-sweeper'],
  },

  /* Per-user */
  {
    key: 'CFG_USER_DEFAULT_SHARE',
    scope: 'user',
    type: 'select',
    choices: ['default', 'private', 'shared', 'everyone'],
    default: 'default',
    label: 'How widely what you create is shared',
    description: 'Where anything you create as shared starts out: private, shared with its group, or with everyone who has an account. "Default" follows the system setting.',
    group: 'Sharing',
  },
  {
    key: 'HISTSIZE',
    scope: 'user',
    type: 'number',
    default: '1000',
    label: 'Shell history length',
    description: 'How many commands the terminal remembers between sessions.',
    group: 'Shell',
  },
  {
    key: 'CFG_USER_HEADER_ENTRANCE',
    scope: 'user',
    type: 'select',
    choices: ['drawn', 'falling', 'sliding', 'sweep', 'growing', 'ripple', 'puzzle', 'wave'],
    default: 'drawn',
    label: 'Header entrance',
    description:
      "How the tiles of a page's header arrive when the page opens: drawn as if by pen and filled from the bottom up, falling into place, sliding in from the right, swept in from left to right, growing from the bottom edge, rippling out from the title, snapping in like puzzle pieces, or a wave of light across them. A device set to reduce motion never animates it.",
    group: 'Appearance',
  },
  {
    key: 'CFG_USER_HEADER_ENTRANCE_TIME',
    scope: 'user',
    type: 'number',
    default: '450',
    label: 'Header entrance time',
    description: "How many milliseconds the header's entrance takes, from the first tile starting to the last one in place. 0 shows the header as it is, without an entrance.",
    group: 'Appearance',
  },
  {
    key: 'CFG_USER_HEADER_COVER',
    scope: 'user',
    type: 'select',
    choices: ['split', 'lines'],
    default: 'split',
    label: 'Header over a cover',
    description:
      "How the tiles of a page's header meet its cover photo: split gives the left of the header to the tiles, dissolving hat by hat into the photo along a slanted edge, with their outlines running on over it; lines lays only their outlines over the photo, fading out from the left.",
    group: 'Appearance',
  },
];
