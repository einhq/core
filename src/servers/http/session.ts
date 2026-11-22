import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { Access, ADMIN_ACCESS, GUEST_ACCESS, GUEST_GID, GUEST_UID, isGuest, storedAccess } from '../../lib/access/mod.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { guestMayBrowse, readSettings, secondsSetting } from '../../lib/config/mod.ts';
import { type AppSession, appSessionHolds, touchAppToken } from '../../managers/devices/app-tokens.ts';
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

/** The value of the cookie `name` in a request's `Cookie` header; the last, when it is there twice. */
function cookieValue(headers: Headers, name: string): string | undefined {
  let value: string | undefined;
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === name) value = pair.slice(at + 1).trim();
  }
  return value;
}

/** Whether a request presents the session cookie, valid or not. */
export const carriesSessionCookie = (config: SessionConfig, headers: Headers): boolean => cookieValue(headers, config.env.COOKIE_NAME) !== undefined;

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
  /** Both, for a session that holds a share link: a screen showing one is rarely reloaded. */
  linkExpiresSec: number;
};

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
    linkExpiresSec: secondsSetting(settings, 'CFG_LINK_SESSION_EXPIRES_SEC'),
  };
}

/**
 * How long the cookie of a session acting as `stored` is kept: a session holding a share link keeps
 * it as long as such a session lasts, and never past the link's own end.
 */
function cookieAge(lifetimes: SessionLifetimes, stored: unknown): number {
  const { link } = storedAccess(stored);
  if (!link) return lifetimes.cookieMaxAgeSec;
  const left = link.expiresAt === undefined ? Infinity : Math.max(0, Math.floor((link.expiresAt - Date.now()) / 1000));
  return Math.min(lifetimes.linkExpiresSec, left);
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
 * GET: an upload, and the shell's WebSocket. Same-site pages of other origins get it all the same,
 * so the server refuses their WebSockets and writes (`same-origin.ts`).
 *
 * `Path=/` is the whole point of this being a function. Without it the
 * browser derives a default-path from the request URI, which is the directory
 * of whatever URL happened to mint the session: a first visit to
 * `/pipelines/media-describe/<id>` would scope the cookie to
 * `/pipelines/media-describe`, and the shell WebSocket at `/__shell` is not
 * under it. `get-shell` would then see a cookie-less client and mint an
 * ephemeral session, so `login --session` would write the authentication into
 * a node that dies with the socket.
 */
function issueCookie(config: SessionConfig, requestHeaders: Headers, responseHeaders: Headers, name: string, secret: string, maxAgeSec: number): void {
  const secure = isForwardedHttps(requestHeaders) ? ['Secure'] : [];
  responseHeaders.append('set-cookie', [`${config.env.COOKIE_NAME}=${name}.${secret}`, ...secure, 'HttpOnly', `Max-Age=${maxAgeSec}`, 'SameSite=Lax', 'Path=/'].join('; '));
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
   * `PUT /file`, every `POST /track` from a script — none of which could ever
   * present it again. Only the SPA document creates one, because it is the one
   * response a browser will actually keep the cookie from.
   */
  create?: boolean;

  /**
   * Whether to write the cookie of a session the request presents again, with a fresh lifetime.
   * Default: when the caller could have created one, neither `create: false` nor `ephemeral`.
   */
  refresh?: boolean;
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
  const sessionIdent = parseSessionCookie(cookieValue(headers, config.env.COOKIE_NAME));

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

      const app = sessionNode.attrs.app;
      if (app && !await appSessionHolds(config.vfs, app)) {
        throw new Error('received session of an app whose token was withdrawn');
      }

      const now = Date.now();
      if (now - (sessionNode.attrs.lastActivity ?? 0) >= SESSION_ACTIVITY_FLOOR_MS) {
        sessionNode = await config.vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, {
          attrs: {
            lastActivity: now,
          },
        });
        if (app) await touchAppToken(config.vfs, app, undefined, now);
      }
    } catch (err) {
      logger.warn((err as Error).message);
      sessionNode = undefined;
      sessionPath = '';
    }
  }

  if (sessionNode && sessionIdent && (opts.refresh ?? (opts.create !== false && !opts.ephemeral))) {
    // Re-stamp on every navigation, so a session in daily use does not expire
    // one cookie lifetime after it was first minted. Only the document response
    // and `/__session` do this: they are not cached, and they cost one header
    // per navigation rather than one per asset.
    issueCookie(config, headers, responseHeaders, sessionIdent.name, sessionNode.attrs.secret, cookieAge(await sessionLifetimes(config), sessionNode.attrs.access));
  }

  if (!sessionNode && opts.create === false) {
    // No usable cookie and the caller does not need a session: answer as a
    // guest and write nothing. `sessionPath` stays empty — callers that need
    // one (the WebSocket shell) do not pass create: false.
    return { responseHeaders, sessionPath: '', access: GUEST_ACCESS };
  }

  if (!sessionNode) {
    ({ sessionPath, sessionNode } = await createSession(config, headers, responseHeaders, { uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] }, opts.ephemeral));
  }

  return {
    responseHeaders,
    sessionPath,
    access: storedAccess(sessionNode.attrs.access),
  };
}

/**
 * A new session acting as `access`, its cookie written to `responseHeaders`: for as long as a
 * session holding a share link lasts when `access` holds one, else as long as any. One opened by
 * the app's token names it (`app`) and carries its own id as its `sid`, as a shell's sign-in does.
 */
async function createSession(
  config: SessionConfig,
  headers: Headers,
  responseHeaders: Headers,
  access: Access,
  ephemeral?: boolean,
  app?: AppSession,
): Promise<{ sessionPath: NodePath; sessionNode: Node<SessionAttrs> }> {
  const lifetimes = await sessionLifetimes(config);
  const name = ulid();
  const sessionPath = join(config.env.SESSIONS_PATH, `session-${name}`);
  if (app) access = { ...access, sid: basename(sessionPath) };
  const sessionNode = await config.vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, dirname(sessionPath), basename(sessionPath), {
    props: {
      mode: 0o700,
    },
    attrs: {
      secret: crypto.randomUUID().replaceAll('-', ''),
      access,
      env: {},
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresSec: access.link ? lifetimes.linkExpiresSec : lifetimes.expiresSec,
      ...(ephemeral ? { bootId: BOOT_ID } : {}),
      ...(app ? { app } : {}),
    },
  });

  issueCookie(config, headers, responseHeaders, name, sessionNode.attrs.secret, cookieAge(lifetimes, access));
  return { sessionPath, sessionNode };
}

/**
 * A session of its own for a browser that cannot sign in, acting as `access` (which holds a link,
 * so it is read-only): the response headers that give the browser its cookie.
 */
export async function openSessionAs(config: SessionConfig, headers: Headers, access: Access): Promise<Headers> {
  const responseHeaders = new Headers();
  await createSession(config, headers, responseHeaders, access);
  return responseHeaders;
}

/**
 * A session for the EiN app, acting as `access`, the account its token acts as: the response
 * headers that give the app's WebView its cookie, and the session's id.
 */
export async function openAppSession(config: SessionConfig, headers: Headers, access: Access, app: AppSession): Promise<{ responseHeaders: Headers; sid: string }> {
  const responseHeaders = new Headers();
  const { sessionPath } = await createSession(config, headers, responseHeaders, access, false, app);
  return { responseHeaders, sid: basename(sessionPath) };
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
