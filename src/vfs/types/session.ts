import { Access } from '../../lib/access/mod.ts';
import { newToken } from '../../lib/token/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

export type SessionAttrs = NodeAttrs & {
  secret: string;
  access: Access;
  createdAt: number;
  lastActivity: number;
  expiresSec?: number;
  expired?: boolean;
  env: Record<string, string>;

  /**
   * `BOOT_ID` of the process that created this session, when the session is
   * reachable only from that process — an SSH channel, or a WebSocket shell
   * whose client never received the cookie. Absent for cookie-backed HTTP
   * sessions, which are meant to survive a restart. See `session-reap`.
   */
  bootId?: string;

  /**
   * `BOOT_ID` of the process whose page stream the session shows (`/__page/<ticket>`): a cookie-backed
   * session that ends with its stream, and every stream ends with the process that served it, so
   * another process refuses the session and `session-reap` collects it.
   */
  endsWithBoot?: string;

  /**
   * The EiN app's token the session was opened with (`/__app/session`): the phone it is paired with
   * and the token's id. The session ends when the phone no longer holds that token.
   */
  app?: { device: string; id: string };

  /**
   * How the browser takes up the secret after a sign-in, elevation or sign-out changed it
   * (`renewSessionSecret`): a one-time token the command answered its own socket with, which
   * `POST /__session` exchanges for the new cookie until `expiresAt`.
   */
  handover?: { token: string; expiresAt: number };
};

export const NODE_TYPE_SESSION: NodeType = 'session';

/**
 * Whether a node is a session: a `session` node with a secret. A cookie names only these, so
 * another node under the sessions directory with a `secret` and an `access` attr is nobody's.
 */
export const isSessionNode = (node: Node): node is Node<SessionAttrs> => node.type === NODE_TYPE_SESSION && typeof node.attrs.secret === 'string';

/** A session's secret, the part of its cookie after its name: 32 hex digits. */
export const newSessionSecret = (): string => crypto.randomUUID().replaceAll('-', '');

/** How long a handover token (`SessionAttrs.handover`) can be exchanged for the new cookie. */
const HANDOVER_TTL_MS = 60_000;

/**
 * A new secret for a session whose sign-in changes, with the token that hands it to the browser: the
 * attrs to write into the session. Whoever held the old cookie — one planted in the browser before
 * the sign-in, say — holds nothing from then on.
 */
export const renewSessionSecret = (): Pick<SessionAttrs, 'secret' | 'handover'> => ({
  secret: newSessionSecret(),
  handover: { token: newToken(), expiresAt: Date.now() + HANDOVER_TTL_MS },
});
