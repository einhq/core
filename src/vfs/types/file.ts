import type { Node, NodeAttrs, NodeId, NodeType } from '../node.ts';

/**
 * FileAttrs - Attributes for file nodes
 *
 * File nodes represent files stored on disk. Their content is located by
 * node id through the file registry; no attribute records a disk or VFS path.
 */
export type FileAttrs = NodeAttrs & {
  /** Display name for the file */
  name: string;

  /** Optional description */
  description?: string | null;

  /** MIME type of the file */
  mimetype: string;

  /** File size in bytes */
  size: number;

  /** SHA256 hash of the file content (optional) */
  sha256?: string;

  /**
   * When the content last changed (ISO 8601): stamped by every content write,
   * or set by an SFTP client (`rsync -t`, `put -p`). What SFTP reports as the
   * file's mtime; absent on content that never passed through the VFS.
   */
  writtenAt?: string;

  /** If true, prevents write operations to this file */
  frozen?: boolean;

  /** ID of the source file this is a version of (for generated versions) */
  sourceId?: NodeId;
};

export const NODE_TYPE_FILE: NodeType = 'file';

/**
 * True for a file that exists because of another file: a rendition (thumbnail,
 * transcode, face crop) or a `versions/` member such as a RAW behind its JPG
 * partner. Both are marked the same way, by `sourceId` naming what they came
 * from.
 *
 * Takes loose attrs because callers hold them as a bag rather than a typed
 * node (a registry's `ResourceOptions`, an event's attrs).
 */
export const isDerivedFile = (attrs: Record<string, unknown> | undefined): boolean => typeof attrs?.sourceId === 'string' && attrs.sourceId !== '';

/**
 * When a node's content last changed, in ms: `attrs.writtenAt`, stamped on
 * every content write and set by a client (SFTP SETSTAT, `scp -p`), else when
 * the node was created. Never `props.modtime`, which moves on every attr update
 * (a pipeline step's marker counts), so rsync and backups would see a changed
 * file.
 */
export const contentTime = (node: Node): number => {
  const writtenAt = Date.parse((node.attrs as { writtenAt?: string }).writtenAt ?? '');
  return Number.isNaN(writtenAt) ? node.props.birthtime?.timestamp ?? 0 : writtenAt;
};
