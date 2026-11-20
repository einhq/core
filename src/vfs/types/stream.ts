import type { NodeType } from '../node.ts';

/**
 * A stream: live bytes from one writer to any number of readers, as the stream registry carries
 * them; nothing is kept. A camera's video is one, written by its device's driver. One whose
 * `mimetype` is an `image/*` is a stream of pictures, a read giving the latest.
 */
export const NODE_TYPE_STREAM: NodeType = 'stream';
