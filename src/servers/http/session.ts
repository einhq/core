import { getCookies, setCookie } from '@std/http';
import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { Access, ADMIN_ACCESS, GUEST_ACCESS, GUEST_GID, GUEST_UID, isGuest, storedAccess } from '../../lib/access/mod.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { getConfigOption, guestMayBrowse, readSettings } from '../../lib/config/mod.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import { Node, NodePath, NodeVFS } from '../../vfs/mod.ts';
import { isSessionNode, NODE_TYPE_SESSION, SessionAttrs } from '../../vfs/types/session.ts';

const logger = createLogger('http-session');

/**
 * How stale a session's `lastActivity` may get. Every asset a page loads presents the cookie, and
 * `session-reap` ages a session out hours after its last activity, so the session is written at
 * most once a minute rather than on every request.
 */
export const SESSION_ACTIVITY_FLOOR_MS = 60_000;

export type SessionConfig = {
  vfs: NodeVFS;
  env: Record<string, string>;
};

function parseSessionCookie(value?: string): { name: string; secret: string } | false {
  if (!value || !value.includes('.')) {
    return false;
  }

  const [id, secret] = value.split('.');

  if (!id || !secret) {
    return false;
  }

  return { name: id, secret };
}

type SessionLifetimes = {
  /** How long the browser keeps the cookie. Refreshed on every navigation, so it bounds idleness, not session age. */
  cookieMaxAgeSec: number;
  /** A new session's `expiresSec`: how long after its last activity `session-reap` collects it. */
  expiresSec: number;
};

/** A positive number of seconds from the settings, or the option's default when it is unset or unusable. */
function secondsSetting(settings: Record<string, string>, key: string): number {
  const seconds = Number(settings[key]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : Number(getConfigOption(key)!.default);
}

/**
 * The lifetimes as the settings say now, so a change applies from the next
 * navigation without restarting the server. Read only when a cookie is written
 * or a session created, never on an asset fetch.
 */
async function sessionLifetimes(config: SessionConfig): Promise<SessionLifetimes> {
  const settings = await readSettings({ sys: { vfs: config.vfs }, env: config.env }, ADMIN_ACCESS, { user: false });
  return {
    cookieMaxAgeSec: secondsSetting(settings, 'CFG_SESSION_MAX_AGE_SEC'),
    expiresSec: secondsSetting(settings, 'CFG_SESSION_EXPIRES_SEC'),
  };
}

/**
 * Whether the browser reached EiN over HTTPS. EiN itself serves plain HTTP, so
 * that happens only behind a TLS-terminating proxy, which says so in
 * `X-Forwarded-Proto` or `Forwarded`; the first entry is the client's hop.
 *
 * The header is believed from anyone: a client that claims HTTPS over plain
 * HTTP only earns a `Secure` cookie its own browser will not send back.
 */
export function isForwardedHttps(headers: Headers): boolean {
  const xfp = headers.get('x-forwarded-proto');
  if (xfp) {
    return xfp.split(',')[0].trim().toLowerCase() === 'https';
  }

  const forwarded = headers.get('forwarded');
  if (forwarded) {
    const proto = forwarded.split(',')[0].split(';')
      .map((pair) => pair.trim().split('='))
      .find(([key]) => key.toLowerCase() === 'proto');
    return proto?.[1]?.replaceAll('"', '').toLowerCase() === 'https';
  }

  return false;
}

/**
 * Write the session cookie. It is `Secure` when the request came over HTTPS,
 * so the same server keeps working over plain HTTP on the LAN.
 *
 * `Lax`, not `Strict`: a link followed from mail or a chat — a share link, above
 * all — is a cross-site navigation, which a `Strict` cookie stays behind on, and
 * the session the document then mints would replace it and sign the reader out.
 * `Lax` still keeps the cookie off cross-site requests that are not a top-level
 * GET: an upload, and the shell's WebSocket.
 *
 * `path: '/'` is the whole point of this being a function. Without it the
 * browser derives a default-path from the request URI, which is the directory
 * of whatever URL happened to mint the session: a first visit to
 * `/pipelines/media-describe/<id>` would scope the cookie to
 * `/pipelines/media-describe`, and the shell WebSocket at `/__shell` is not
 * under it. `get-shell` would then see a cookie-less client and mint an
 * ephemeral session, so `login --session` would write the authentication into
 * a node that dies with the socket.
 */
function issueCookie(config: SessionConfig, requestHeaders: Headers, responseHeaders: Headers, name: string, secret: string, maxAgeSec: number): void {
  setCookie(responseHeaders, {
    name: config.env.COOKIE_NAME,
    value: `${name}.${secret}`,
    path: '/',
    secure: isForwardedHttps(requestHeaders),
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: maxAgeSec,
  });
}

type GetSessionOptions = {
  /**
   * The caller cannot deliver `responseHeaders` to the client, so a session
   * created now is reachable only for the life of this process — stamp it so
   * `session-reap` can collect it instead of keeping it forever.
   *
   * Set by the WebSocket handler: `Deno.upgradeWebSocket` returns a 101 whose
   * headers we cannot extend, so a WS client arriving without a cookie never
   * receives one and reconnects as a stranger every time.
   */
  ephemeral?: boolean;

  /**
   * Whether to mint a session when the request carries no usable cookie.
   * Default true.
   *
   * A request that only needs to know *who is asking* does not need a session:
   * without a cookie the answer is "a guest" either way. Creating one anyway
   * would write a durable node per anonymous request — every asset fetch, every
   * `PUT /file`, every tracker device posting a fix — none of which could ever
   * present it again. Only the SPA document creates one, because it is the one
   * response a browser will actually keep the cookie from.
   */
  create?: boolean;
};

/**
 * Whether a request acting as `access` is refused for being the guest: where visitors are asked
 * to sign in, the guest reads nothing but the site's own pages. A share link's visitor is not the
 * guest.
 */
export const refusesGuest = async (config: SessionConfig, access: Access): Promise<boolean> => isGuest(access) && !await guestMayBrowse(config.vfs);

export async function getSession(
  config: SessionConfig,
  headers: Headers,
  opts: GetSessionOptions = {},
): Promise<{ responseHeaders: Headers; sessionPath: NodePath; access: Access }> {
  const responseHeaders = new Headers();
  const sessionIdent = parseSessionCookie(getCookies(headers)[config.env.COOKIE_NAME]);

  let sessionNode: Node<SessionAttrs> | undefined = undefined;
  let sessionPath: NodePath = '';

  if (sessionIdent) {
    try {
      sessionPath = join(config.env.SESSIONS_PATH, `session-${sessionIdent.name}`);
      sessionNode = await config.vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);

      if (!isSessionNode(sessionNode)) {
        throw new Error('received session id that names no session');
      }

      if (sessionNode.attrs.expired) {
        throw new Error('received session id which has expired');
      }

      if (sessionNode.attrs.secret !== sessionIdent.secret) {
        throw new Error('received session id cookie with non-matching secret');
      }

      const now = Date.now();
      if (now - (sessionNode.attrs.lastActivity ?? 0) >= SESSION_ACTIVITY_FLOOR_MS) {
        sessionNode = await config.vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, {
          attrs: {
            lastActivity: now,
          },
        });
      }
    } catch (err) {
      logger.warn((err as Error).message);
      sessionNode = undefined;
      sessionPath = '';
    }
  }

  if (sessionNode && sessionIdent && opts.create !== false && !opts.ephemeral) {
    // Re-stamp on every navigation, so a session in daily use does not expire
    // one cookie lifetime after it was first minted. Only the document response
    // does this: it is the one the caller can deliver headers on, it is not
    // cached, and it costs one header per navigation rather than one per asset.
    const { cookieMaxAgeSec } = await sessionLifetimes(config);
    issueCookie(config, headers, responseHeaders, sessionIdent.name, sessionNode.attrs.secret, cookieMaxAgeSec);
  }

  if (!sessionNode && opts.create === false) {
    // No usable cookie and the caller does not need a session: answer as a
    // guest and write nothing. `sessionPath` stays empty — callers that need
    // one (the WebSocket shell) do not pass create: false.
    return { responseHeaders, sessionPath: '', access: GUEST_ACCESS };
  }

  if (!sessionNode) {
    const lifetimes = await sessionLifetimes(config);
    const name = ulid();
    sessionPath = join(config.env.SESSIONS_PATH, `session-${name}`);
    sessionNode = await config.vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, dirname(sessionPath), basename(sessionPath), {
      props: {
        mode: 0o700,
      },
      attrs: {
        secret: crypto.randomUUID().replaceAll('-', ''),
        access: {
          uid: GUEST_UID,
          gid: GUEST_GID,
          gids: [GUEST_GID],
        },
        env: {},
        createdAt: Date.now(),
        lastActivity: Date.now(),
        expiresSec: lifetimes.expiresSec,
        ...(opts.ephemeral ? { bootId: BOOT_ID } : {}),
      },
    });

    issueCookie(config, headers, responseHeaders, name, sessionNode.attrs.secret, lifetimes.cookieMaxAgeSec);
  }

  return {
    responseHeaders,
    sessionPath,
    access: storedAccess(sessionNode.attrs.access),
  };
}

/**
 * Remove a session created for this process only (see `GetSessionOptions`).
 *
 * A cookie-backed session must survive the socket that used it — the browser
 * will present it again on the next page load — so this checks the stamp rather
 * than trusting the caller: only a session carrying *this* `BOOT_ID` is dropped.
 */
export async function removeEphemeralSession(config: SessionConfig, sessionPath: NodePath): Promise<void> {
  try {
    const node = await config.vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);
    if (node.attrs.bootId !== BOOT_ID) {
      return;
    }
    await config.vfs.unlink(ADMIN_ACCESS, sessionPath, dirname(sessionPath), { recursive: true, readlink: true });
  } catch (err) {
    logger.debug('ephemeral session cleanup failed', { sessionPath, error: (err as Error).message });
  }
}
