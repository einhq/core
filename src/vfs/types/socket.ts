import type { NodeType } from '../node.ts';

/**
 * A socket: a meeting point between one listener and any number of clients, as the socket registry
 * carries it; nothing is kept. Its owner listens on it (opens it to read) and accepts connections;
 * whoever may read and write it connects (opens it to write), each connection a two-way channel of
 * whole messages between that client and the listener alone.
 */
export const NODE_TYPE_SOCKET: NodeType = 'socket';
