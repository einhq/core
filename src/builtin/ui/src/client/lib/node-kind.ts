/**
 * What a raw VFS node looks like in the explorer.
 *
 * The search grid's `entity-kind.ts` vocabulary covers the things a person
 * looks for — albums, people, locations. The explorer shows everything, including
 * the plumbing (sessions, queues, routers), so it extends that vocabulary
 * rather than replacing it: an album is drawn the same way here as on a card.
 */
import {
  IconCircleOff,
  IconFile,
  IconFileDescription,
  IconFileText,
  IconFolder,
  IconInfoCircle,
  IconLink,
  IconListDetails,
  IconMapPin2,
  IconPhoto,
  IconQuestionMark,
  IconRouter,
  IconStack2,
  IconTerminal,
  IconTerminal2,
  IconUser,
  IconUsersGroup,
  IconVector,
  IconVideo,
} from '@tabler/icons-react';
import { ENTITY_KIND_STYLES, type EntityKindStyle } from './entity-kind.ts';
import type { NodeChildEntry } from './node-entry.ts';

export type NodeKindStyle = EntityKindStyle;

const KIND: Record<string, NodeKindStyle> = {
  directory: { label: 'Directory', color: 'yellow', icon: IconFolder },
  album: ENTITY_KIND_STYLES.album,
  person: ENTITY_KIND_STYLES.person,
  location: ENTITY_KIND_STYLES.location,
  device: ENTITY_KIND_STYLES.device,
  track: ENTITY_KIND_STYLES.track,
  softlink: { label: 'Link', color: 'gray', icon: IconLink },
  user: { label: 'User', color: 'grape', icon: IconUser },
  group: { label: 'Group', color: 'grape', icon: IconUsersGroup },
  session: { label: 'Session', color: 'gray', icon: IconTerminal2 },
  tty: { label: 'Terminal', color: 'gray', icon: IconTerminal2 },
  router: { label: 'Router', color: 'indigo', icon: IconRouter },
  null: { label: 'Null', color: 'gray', icon: IconCircleOff },
  pool: { label: 'Pool', color: 'indigo', icon: IconStack2 },
  queue: { label: 'Queue', color: 'indigo', icon: IconListDetails },
  exif: { label: 'EXIF', color: 'gray', icon: IconInfoCircle },
  embedding: { label: 'Embedding', color: 'gray', icon: IconVector },
  position: { label: 'Position', color: 'gray', icon: IconMapPin2 },
  log: { label: 'Log', color: 'gray', icon: IconFileDescription },
  command: { label: 'Command', color: 'gray', icon: IconTerminal },
};

const FILE: Record<string, NodeKindStyle> = {
  image: { label: 'Image', color: 'green', icon: IconPhoto },
  video: { label: 'Video', color: 'red', icon: IconVideo },
  audio: ENTITY_KIND_STYLES.audio,
  text: { label: 'Text', color: 'lime', icon: IconFileText },
};

const UNKNOWN: NodeKindStyle = { label: 'Node', color: 'gray', icon: IconQuestionMark };
const PLAIN_FILE: NodeKindStyle = { label: 'File', color: 'gray', icon: IconFile };

/** Icon, colour and label for an entry; files are told apart by mimetype. */
export function nodeKindOf(entry: Pick<NodeChildEntry, 'node'>): NodeKindStyle {
  const { type, attrs } = entry.node;
  if (type === 'file') {
    const major = (attrs.mimetype ?? '').split('/')[0];
    if (major === 'application' && /json|xml|javascript/.test(attrs.mimetype ?? '')) return FILE.text;
    return FILE[major] ?? PLAIN_FILE;
  }
  if (type === 'album' && attrs.origin === 'auto') return ENTITY_KIND_STYLES.suggested;
  return KIND[type] ?? UNKNOWN;
}

/** The type column: the node type, with a file's mimetype instead when it has one. */
export function nodeTypeLabel(entry: Pick<NodeChildEntry, 'node'>): string {
  const { type, attrs } = entry.node;
  if (type === 'file' && attrs.mimetype) return attrs.mimetype;
  return type;
}
