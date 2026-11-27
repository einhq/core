import type { ResourceHandleIf, ResourceOptions } from '../types.ts';

/** What one side of a connection may hold unread before the connection is let go: a side that falls this far behind reads to its end. */
export const SOCKET_BUFFER = 8 * 1024 * 1024;

/** How many connections may wait for the listener to accept them; one more is refused. */
export const SOCKET_BACKLOG = 128;

/** Who opened a connection: the uid and group of the access that connected, and the invitation it came through. */
export type SocketPeer = { uid: number; gid: number; invitation?: string };

/** How the VFS opens a socket: the node's attrs, and for a connection, who connects. */
export type SocketResourceOptions = ResourceOptions & { peer?: SocketPeer };

/**
 * A socket's listener: the handle the VFS gives the socket's owner who opens it to read, while
 * nobody else listens. It neither reads nor writes; it accepts connections. Closing it ends every
 * connection it has, accepted or waiting.
 */
export interface SocketListener extends ResourceHandleIf {
  /** The next connection, waited for; undefined once the listener is closed or the socket's node removed. */
  accept(signal?: AbortSignal): Promise<SocketConnection | undefined>;
}

/**
 * One end of a connection: what a client who opens a socket to write is given, and what the
 * listener's `accept` gives for it. Each write is one message to the other end; each read answers
 * one message from it, whole when the size asked for holds it, and an empty read is the end.
 * Closing either end ends the connection for both; what the other end holds it still reads.
 */
export interface SocketConnection extends ResourceHandleIf {
  /** Who opened the connection. */
  readonly peer: SocketPeer;
  /** Whether the connection was let go because one end fell more than `SOCKET_BUFFER` behind. */
  readonly behind: boolean;
}

/** Whether `handle` is a socket's listener, as the VFS opens one for its owner to read. */
export const isSocketListener = (handle: ResourceHandleIf): handle is SocketListener => typeof (handle as Partial<SocketListener>).accept === 'function';

/** Whether `handle` is one end of a socket's connection. */
export const isSocketConnection = (handle: ResourceHandleIf): handle is SocketConnection =>
  typeof (handle as Partial<SocketConnection>).peer === 'object' && typeof (handle as Partial<SocketConnection>).behind === 'boolean';
