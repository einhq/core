import type { NodeTypeDoc } from './types.ts';

/**
 * The node types core defines (`src/vfs/types/`), described for a reader of the archive rather
 * than for its code. Modules describe their own (`album`, `person`, …) in `mod.json`.
 */
export const CORE_NODE_TYPES: NodeTypeDoc[] = [
  {
    type: 'directory',
    label: 'Directory',
    category: 'structure',
    description: 'A folder that holds other nodes. The archive roots — albums, people, locations, devices and labels — are directories.',
  },
  {
    type: 'file',
    label: 'File',
    category: 'content',
    description:
      'Stored bytes with a name, a mimetype, a size and a checksum: a photo, a video, a document, an event text. Media files carry what was read from them (capture time, orientation, faces) and hold their derived pieces — thumbnails, captions, EXIF — as children.',
  },
  {
    type: 'softlink',
    label: 'Softlink',
    category: 'structure',
    description:
      'A pointer to another node by path, followed transparently. Album covers, pictures added to an album, labels and the relations between people and locations are all softlinks.',
  },
  {
    type: 'position',
    label: 'Position',
    category: 'content',
    description: 'A point on the map with an optional radius or outline. A photo, a location or an event keeps where it is as a child named position.',
  },
  {
    type: 'track',
    label: 'Track',
    category: 'content',
    description:
      "The route a device recorded, kept as the device's child named track: timestamped GPS points, live or from imported GPX files, summarised by their extent and time span.",
  },
  {
    type: 'user',
    label: 'User',
    category: 'structure',
    description: 'An account that can sign in, under /home. Owns nodes, belongs to groups, and keeps its settings and shell history in its home directory.',
  },
  {
    type: 'group',
    label: 'Group',
    category: 'structure',
    description: "A set of users, under /etc/groups. A node's group, and any group in its ACL, decides who besides the owner may read or change it.",
  },
  {
    type: 'embedding',
    label: 'Embedding',
    category: 'system',
    description: 'A numeric fingerprint of an image, a face or a text, kept for similarity search: what finds photos by what they show and faces of the same person.',
  },
  {
    type: 'command',
    label: 'Command',
    category: 'system',
    description: "A built-in shell command, carrying its own description, arguments and flags. Commands a module adds are files in the module's bin directory instead.",
  },
  {
    type: 'log',
    label: 'Log',
    category: 'system',
    description: 'An append-only record of lines kept for a retention period, such as the system log under /var/logs.',
  },
  {
    type: 'queue',
    label: 'Queue',
    category: 'system',
    description: 'A durable first-in, first-out buffer; reading an entry removes it. The pipeline engine takes its work from one.',
  },
  {
    type: 'pool',
    label: 'Pool',
    category: 'system',
    description: 'Background jobs waiting for a worker with the right resources, under /var/pools. `pool stat` shows what is waiting.',
  },
  {
    type: 'router',
    label: 'Router',
    category: 'system',
    description: 'A live broadcast channel: what is written reaches every current reader and nothing is kept. /dev/events is one.',
  },
  {
    type: 'null',
    label: 'Null',
    category: 'system',
    description: '/dev/null: reading it gives nothing and what is written to it is thrown away, for output nobody wants.',
  },
  {
    type: 'session',
    label: 'Session',
    category: 'system',
    description: 'A signed-in connection — a browser, an SSH login, a service — under /var/sessions. Removed when it ends.',
  },
  {
    type: 'tty',
    label: 'Terminal',
    category: 'system',
    description: 'An interactive terminal belonging to a session, with its size and working directory.',
  },
  {
    type: 'share-link',
    label: 'Share link',
    category: 'system',
    description:
      'A link that opens an album, and what it holds, to whoever has it, without signing in; under /var/links, with when it expires and how often it was opened. `share-link` makes, lists and turns them off.',
  },
];
