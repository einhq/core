import type { UserId } from './ids.ts';

/** A node an invitation opens, where it is now, and how: a stream `r` to read it or `w` to write it, a socket `rw` to connect to it. */
export type InvitationNode = { path: string; mode: 'r' | 'w' | 'rw' };

/** An invitation as `invitation list` answers it: never its token, which only its creation gave. */
export type Invitation = {
  id: string;
  /** The nodes it opens; one removed since is left out. */
  nodes: InvitationNode[];
  createdBy: { uid: UserId; name?: string };
  createdAt: number;
  /** Epoch ms after which it opens nothing. */
  expiresAt: number;
  /** How many sockets it opened, and when last. */
  opened: number;
  lastOpenedAt?: number;
};

/** What `invitation create` answers: the invitation, and once only its token and the link that carries it. */
export type InvitationCreated = Invitation & {
  token: string;
  /** `/__invite/<token>`, on this server's own address. */
  link: string;
};

/**
 * What `GET /__invite/<token>` answers, to any page of any origin: the nodes the invitation opens
 * and how, each over a WebSocket at `/file/<path>?mode=<mode>&invite=<token>`, and when it stops.
 */
export type InvitationLink = {
  nodes: InvitationNode[];
  /** When it stops opening anything, as an ISO date; null for one that does not. */
  expires: string | null;
};
