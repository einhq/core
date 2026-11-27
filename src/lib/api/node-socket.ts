/**
 * The close codes a node's WebSocket (`/file/<path>?mode=r|w|rw`) ends with, beside 1001 (the server
 * stopping). What is refused before the socket may read or write closes it at once, with 4000 + the
 * HTTP status the same refusal would get and a reason a page can show.
 */
export const NODE_SOCKET_CLOSE = {
  /** The stream's writer closed, a stream of pictures gave its picture, or the socket's connection ended. */
  ended: 1000,
  /** A text message, or any message on a reader's socket. */
  unsupported: 1003,
  /** A message larger than a reader may hold (8 MiB). */
  tooBig: 1009,
  /** Something failed on the server. */
  failed: 1011,
  /** The reader, or one end of a connection, fell more than its queue (8 MiB) behind and was let go. */
  behind: 4001,
  /** No `mode`, or one the node does not open with, or a node that is neither a stream nor a socket. */
  badRequest: 4400,
  /** The guest may not browse here: sign in first. */
  signIn: 4401,
  /** The access does not reach the node in that mode, or the ticket or invitation does not. */
  forbidden: 4403,
  /** No node at the path. */
  notFound: 4404,
  /** The stream has a writer already. */
  conflict: 4409,
  /** The stream's node was removed while the socket wrote it, or the invitation it opened with expired or was turned off. */
  gone: 4410,
  /** Nobody listens on the socket, or too many connections wait for its listener. */
  unavailable: 4503,
} as const;
