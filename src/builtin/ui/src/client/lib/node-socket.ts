import type { InvitationLink, InvitationNode } from '@ein/api';
import { encodeVfsPath } from './file-url.ts';

/** How a node's socket opens it: `r` reads a stream, `w` writes it, `rw` connects to a socket node. */
export type NodeSocketMode = 'r' | 'w' | 'rw';

export type NodeSocketOptions = {
  /** A file ticket to read with in place of the session (`?ticket=`). */
  ticket?: string;
  /** An invitation's token to open the node with in place of the session (`?invite=`). */
  invite?: string;
  /** The EiN the node is on, as `https://ein.example`, when it is not the page's own; for an invitation from another. */
  origin?: string;
};

/** An invitation as a page holds it: the EiN it is from, its token, and the nodes it opens. */
export type NodeInvitation = InvitationLink & { origin: string; token: string };

/** The `ws:` or `wss:` URL of the node at `path`'s socket, on `options.origin` or the page's own host. */
export function nodeSocketUrl(path: string, mode: NodeSocketMode, options: NodeSocketOptions = {}, page: Pick<Location, 'protocol' | 'host'> = globalThis.location): string {
  const query = new URLSearchParams({ mode });
  if (options.ticket !== undefined) query.set('ticket', options.ticket);
  if (options.invite !== undefined) query.set('invite', options.invite);
  const server = options.origin !== undefined ? new URL(options.origin) : page;
  const protocol = server.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${server.host}/file${encodeVfsPath(path)}?${query}`;
}

/**
 * A WebSocket on the node at `path`, binary, its messages as `ArrayBuffer`s. Of a stream, `w` makes
 * the socket its writer, each message sent one write, and `r` gives each write as one message. Of a
 * socket node, `rw` is a connection to its listener, each message sent one message to it and each
 * message from it one message. The close code says why it ended (`NODE_SOCKET_CLOSE`).
 */
export function openNodeSocket(path: string, mode: NodeSocketMode, options: NodeSocketOptions = {}): WebSocket {
  const socket = new WebSocket(nodeSocketUrl(path, mode, options));
  socket.binaryType = 'arraybuffer';
  return socket;
}

/** The token and the EiN an invitation's link (`<origin>/__invite/<token>`) names; undefined when it is not one. */
export function parseInvitationLink(link: string, page: string = globalThis.location?.href): { origin: string; token: string } | undefined {
  let url: URL;
  try {
    url = new URL(link.trim(), page);
  } catch {
    return undefined;
  }
  const token = /^\/__invite\/([A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  return token && (url.protocol === 'https:' || url.protocol === 'http:') ? { origin: url.origin, token } : undefined;
}

/**
 * What the invitation `link` opens, asked of the EiN it is from: each node to open with
 * `openNodeSocket(node.path, node.mode, { origin, invite: token })`. Throws when the link is not an
 * invitation's, or it no longer opens anything.
 */
export async function fetchInvitation(link: string): Promise<NodeInvitation> {
  const parsed = parseInvitationLink(link);
  if (!parsed) throw new Error('not an invitation link: one ends in /__invite/<token>');
  const res = await fetch(`${parsed.origin}/__invite/${parsed.token}`, { credentials: 'omit', cache: 'no-store' });
  const body = await res.json().catch(() => undefined) as (InvitationLink & { error?: string }) | undefined;
  if (!res.ok || !body || !Array.isArray(body.nodes)) throw new Error(body?.error ?? `the invitation could not be read (${res.status})`);
  return { ...parsed, nodes: body.nodes as InvitationNode[], expires: body.expires };
}
