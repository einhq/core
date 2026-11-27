# socket

A socket is a meeting point between one listener and any number of clients, kept in this process's
memory and nowhere else: a game server and its players, a service and the pages that talk to it.
Each connection is a two-way channel of whole messages between one client and the listener; nothing
is kept once it ends.

- The listener opens the socket to read (`r`), while nobody else listens, and accepts connections
  (`accept`), each with the `peer` who opened it: the uid and group of its access, and the
  invitation it came through. The VFS lets only the node's owner, or an administrator, listen.
- A client opens it in a mode that writes and is given its end of a new connection. It is refused
  while nobody listens, or while `SOCKET_BACKLOG` (128) connections wait to be accepted. What it
  writes before it is accepted waits in its connection. The VFS lets whoever may read and write the
  node connect.
- Each write is one message to the other end; each read answers one message, whole when the size
  asked for holds it, and an empty read is the end. An empty write sends nothing.
- Each end holds what it has not read, up to `SOCKET_BUFFER` (8 MiB). Past it the connection is let
  go (`behind`): neither end ever waits for the other.
- Closing either end ends the connection for both; the other end still reads what it holds. Closing
  the listener, or removing the node, ends every connection, accepted or waiting.

`stat` gives a size of 0, whether anyone listens, and how many connections there are
(`isSocketListener`, `isSocketConnection`).
