import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { Access, ADMIN_ACCESS, GUEST_ACCESS, GUEST_GID, GUEST_UID, isGuest, storedAccess } from '../../lib/access/mod.ts';
import { BOOT_ID } from '../../lib/boot-id/mod.ts';
import { guestMayBrowse, readSettings, secondsSetting } from '../../lib/config/mod.ts';
import { sameToken } from '../../lib/token/mod.ts';
import { type AppSession, appSessionHolds, touchAppToken } from '../../managers/devices/app-tokens.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import { sessionHeldByShell } from '../../managers/shell/shell.ts';
import { Node, NodeAlreadyExistsError, NodeNotFoundError, NodePath, NodeVFS } from '../../vfs/mod.ts';
import { isSessionNode, newSessionSecret, NODE_TYPE_SESSION, SessionAttrs } from '../../vfs/types/session.ts';

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

/**
 * The session cookie's name for a request: `COOKIE_NAME`, and over HTTPS with the `__Host-` prefix,
 * which the browser keeps only from this very host over HTTPS, so a sibling subdomain or a page
 * served over plain HTTP cannot set the cookie the server reads.
 */
const sessionCookieName = (config: SessionConfig, headers: Headers): string => isForwardedHttps(headers) ? `__Host-${config.env.COOKIE_NAME}` : config.env.COOKIE_NAME;

/** Whether a request presents the session cookie, valid or not. */
export const carriesSessionCookie = (config: SessionConfig, headers: Headers): boolean => cookieValue(headers, sessionCookieName(config, headers)) !== undefined;

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
 * A WebSocket upgrade comes as `wss` (Traefik's), which is HTTPS as well, so
 * the shell's socket reads the same session cookie as the page.
 *
 * The header is believed from anyone: a client that claims HTTPS over plain
 * HTTP only earns a `Secure` cookie its own browser will not send back.
 */
export function isForwardedHttps(headers: Headers): boolean {
  const xfp = headers.get('x-forwarded-proto');
  if (xfp) {
    return isSecureProto(xfp.split(',')[0].trim());
  }

  const forwarded = headers.get('forwarded');
  if (forwarded) {
    const proto = forwarded.split(',')[0].split(';')
      .map((pair) => pair.trim().split('='))
      .find(([key]) => key.toLowerCase() === 'proto');
    return isSecureProto(proto?.[1]?.replaceAll('"', '') ?? '');
  }

  return false;
}

const isSecureProto = (proto: string): boolean => ['https', 'wss'].includes(proto.toLowerCase());

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
  responseHeaders.append(
    'set-cookie',
    [`${sessionCookieName(config, requestHeaders)}=${name}.${secret}`, ...secure, 'HttpOnly', `Max-Age=${maxAgeSec}`, 'SameSite=Lax', 'Path=/'].join('; '),
  );
}

type GetSessionOptions = {
  /**
   * The caller is a socket, whose shell needs the session's node. A cookie naming the guest's
   * session not written yet (see `create`) gets its node now. Without a usable cookie the session
   * is reachable only for the life of this process, so it is stamped for `session-reap` and
   * dropped when its socket closes (`releaseSession`).
   *
   * `Deno.upgradeWebSocket` returns a 101 whose headers we cannot extend, so a WS client arriving
   * without a cookie never receives one and reconnects as a stranger every time.
   */
  socket?: boolean;

  /**
   * Whether to give a request that carries no usable cookie one. Default true.
   *
   * Only the SPA document does, because it is the one response a browser keeps the cookie from.
   * The cookie names the guest's session, not written yet: it holds nothing but its shells, so its
   * node is written when its first socket opens, and a client that never opens one costs nothing.
   * A request that only needs to know *who is asking* — an asset fetch, a `PUT /file`, a
   * `POST /track` from a script — passes false and is answered as the guest.
   */
  create?: boolean;

  /**
   * Whether to write the cookie of a session the request presents again, with a fresh lifetime.
   * Default: when the caller could have created one, neither `create: false` nor `socket`.
   */
  refresh?: boolean;
};

/**
 * Whether a request acting as `access` is refused for being the guest: where visitors are asked
 * to sign in, the guest reads nothing but the site's own pages. A share link's visitor is not the
 * guest.
 */
export const refusesGuest = async (config: SessionConfig, access: Access): Promise<boolean> => isGuest(access) && !await guestMayBrowse(config.vfs);

type SessionIdent = { name: string; secret: string };

/** A session's name and secret as this server makes them: a ULID, and 32 hex digits. */
const isServerIdent = ({ name, secret }: SessionIdent): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name) && /^[0-9a-f]{32}$/.test(secret);

const newIdent = (): SessionIdent => ({ name: ulid(), secret: newSessionSecret() });

/**
 * The session a cookie names when it is usable: a session node, not ended, with the cookie's secret
 * and, for the app's, a token the phone still holds. `unwritten` when no node is there and the
 * cookie is one this server could have made: the guest's session no socket has written yet, or one
 * collected since, which its browser takes up again as the guest.
 */
async function findSession(config: SessionConfig, ident: SessionIdent, sessionPath: NodePath): Promise<Node<SessionAttrs> | 'unwritten' | undefined> {
  let node: Node;
  try {
    node = await config.vfs.get(ADMIN_ACCESS, sessionPath);
  } catch (err) {
    if (err instanceof NodeNotFoundError && isServerIdent(ident)) return 'unwritten';
    logger.warn('received session id that names no session');
    return undefined;
  }

  if (!isSessionNode(node)) {
    logger.warn('received session id that names no session');
  } else if (node.attrs.expired) {
    logger.warn('received session id which has expired');
  } else if (!sameToken(node.attrs.secret, ident.secret)) {
    logger.warn('received session id cookie with non-matching secret');
  } else if (node.attrs.endsWithBoot !== undefined && node.attrs.endsWithBoot !== BOOT_ID) {
    logger.warn('received session of a page whose stream ended with the process that served it');
  } else if (node.attrs.app && !await appSessionHolds(config.vfs, node.attrs.app)) {
    logger.warn('received session of an app whose token was withdrawn');
  } else {
    return node;
  }
  return undefined;
}

/**
 * The session a request belongs to and the access it acts with. `sessionPath` names a session node,
 * and is empty when there is none: no usable cookie, or the guest's session not written yet.
 */
export async function getSession(
  config: SessionConfig,
  headers: Headers,
  opts: GetSessionOptions = {},
): Promise<{ responseHeaders: Headers; sessionPath: NodePath; access: Access }> {
  const responseHeaders = new Headers();
  const sessionIdent = parseSessionCookie(cookieValue(headers, sessionCookieName(config, headers))) || undefined;
  const sessionPath = sessionIdent ? join(config.env.SESSIONS_PATH, `session-${sessionIdent.name}`) : '';
  const found = sessionIdent ? await findSession(config, sessionIdent, sessionPath) : undefined;

  if (sessionIdent && typeof found === 'object') {
    let sessionNode = found;
    const now = Date.now();
    if (now - (sessionNode.attrs.lastActivity ?? 0) >= SESSION_ACTIVITY_FLOOR_MS) {
      sessionNode = await config.vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, {
        attrs: {
          lastActivity: now,
        },
      });
      if (sessionNode.attrs.app) await touchAppToken(config.vfs, sessionNode.attrs.app, undefined, now);
    }

    if (opts.refresh ?? (opts.create !== false && !opts.socket)) {
      // Re-stamp on every navigation, so a session in daily use does not expire
      // one cookie lifetime after it was first minted. Only the document response
      // and `/__session` do this: they are not cached, and they cost one header
      // per navigation rather than one per asset.
      issueCookie(config, headers, responseHeaders, sessionIdent.name, sessionNode.attrs.secret, cookieAge(await sessionLifetimes(config), sessionNode.attrs.access));
    }

    return { responseHeaders, sessionPath, access: storedAccess(sessionNode.attrs.access) };
  }

  const unwritten = found === 'unwritten' ? sessionIdent : undefined;

  if (opts.socket) {
    const written = unwritten && await writeGuestSession(config, unwritten, sessionPath);
    if (written) return { responseHeaders, sessionPath, access: storedAccess(written.attrs.access) };
    const created = await createSession(config, headers, responseHeaders, { uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] }, { ephemeral: true });
    return { responseHeaders, sessionPath: created.sessionPath, access: storedAccess(created.sessionNode.attrs.access) };
  }

  if (opts.create !== false) {
    // The guest's session not written yet keeps its cookie, written again as a written one's is.
    const ident = unwritten ?? newIdent();
    issueCookie(config, headers, responseHeaders, ident.name, ident.secret, (await sessionLifetimes(config)).cookieMaxAgeSec);
  }

  return { responseHeaders, sessionPath: '', access: GUEST_ACCESS };
}

/**
 * Exchange a handover token (`SessionAttrs.handover`) for the cookie of the session's new secret,
 * once: the response headers that write it, or undefined when the session the request's cookie
 * names holds no such token any more. The cookie the request presents names the session; its old
 * secret no longer matches and proves nothing, the token does.
 */
export async function takeHandover(config: SessionConfig, headers: Headers, token: string): Promise<Headers | undefined> {
  const sessionIdent = parseSessionCookie(cookieValue(headers, sessionCookieName(config, headers)));
  if (!sessionIdent) return undefined;
  const sessionPath = join(config.env.SESSIONS_PATH, `session-${sessionIdent.name}`);
  const node = await config.vfs.get(ADMIN_ACCESS, sessionPath).catch(() => undefined);
  if (!node || !isSessionNode(node) || node.attrs.expired) return undefined;
  const { handover } = node.attrs;
  if (!handover || handover.expiresAt < Date.now() || !sameToken(handover.token, token)) {
    logger.warn('refused a session handover', { session: basename(sessionPath) });
    return undefined;
  }
  const taken = await config.vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, { attrs: { handover: undefined, lastActivity: Date.now() } });
  const responseHeaders = new Headers();
  issueCookie(config, headers, responseHeaders, sessionIdent.name, taken.attrs.secret, cookieAge(await sessionLifetimes(config), taken.attrs.access));
  return responseHeaders;
}

/**
 * Write the guest's session a cookie names, with the cookie's name and secret. The sockets of one
 * page open together, so a node another socket wrote first is taken when its secret matches.
 */
async function writeGuestSession(config: SessionConfig, ident: SessionIdent, sessionPath: NodePath): Promise<Node<SessionAttrs> | undefined> {
  const now = Date.now();
  try {
    return await config.vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, dirname(sessionPath), basename(sessionPath), {
      props: {
        mode: 0o700,
      },
      attrs: {
        secret: ident.secret,
        access: { uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] },
        env: {},
        createdAt: now,
        lastActivity: now,
        expiresSec: (await sessionLifetimes(config)).expiresSec,
      },
    });
  } catch (err) {
    if (!(err instanceof NodeAlreadyExistsError)) throw err;
    const found = await findSession(config, ident, sessionPath);
    return typeof found === 'object' ? found : undefined;
  }
}

/**
 * A new session acting as `access`, its cookie written to `responseHeaders`: for as long as a
 * session holding a share link lasts when `access` holds one, else as long as any. One opened by
 * the app's token names it (`app`) and carries its own id as its `sid`, as a shell's sign-in does;
 * one for a page's stream (`page`) lasts no longer than this process.
 */
async function createSession(
  config: SessionConfig,
  headers: Headers,
  responseHeaders: Headers,
  access: Access,
  { ephemeral, app, page }: { ephemeral?: boolean; app?: AppSession; page?: boolean } = {},
): Promise<{ sessionPath: NodePath; sessionNode: Node<SessionAttrs> }> {
  const lifetimes = await sessionLifetimes(config);
  const { name, secret } = newIdent();
  const sessionPath = join(config.env.SESSIONS_PATH, `session-${name}`);
  if (app) access = { ...access, sid: basename(sessionPath) };
  const sessionNode = await config.vfs.create<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, dirname(sessionPath), basename(sessionPath), {
    props: {
      mode: 0o700,
    },
    attrs: {
      secret,
      access,
      env: {},
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresSec: access.link ? lifetimes.linkExpiresSec : lifetimes.expiresSec,
      ...(ephemeral ? { bootId: BOOT_ID } : {}),
      ...(page ? { endsWithBoot: BOOT_ID } : {}),
      ...(app ? { app } : {}),
    },
  });

  issueCookie(config, headers, responseHeaders, name, sessionNode.attrs.secret, cookieAge(lifetimes, access));
  return { sessionPath, sessionNode };
}

/**
 * A session of its own for the media service's browser showing a page for a screen, acting as
 * `access` (which holds a link, so it is read-only): the response headers that give the browser its
 * cookie, and the session's path, which is removed when the page's stream ends. It lasts no longer
 * than this process, whose streams end with it.
 */
export async function openPageSession(config: SessionConfig, headers: Headers, access: Access): Promise<{ responseHeaders: Headers; sessionPath: NodePath }> {
  const responseHeaders = new Headers();
  const { sessionPath } = await createSession(config, headers, responseHeaders, access, { page: true });
  return { responseHeaders, sessionPath };
}

/**
 * A session for the EiN app, acting as `access`, the account its token acts as: the response
 * headers that give the app's WebView its cookie, and the session's id.
 */
export async function openAppSession(config: SessionConfig, headers: Headers, access: Access, app: AppSession): Promise<{ responseHeaders: Headers; sid: string }> {
  const responseHeaders = new Headers();
  const { sessionPath } = await createSession(config, headers, responseHeaders, access, { app });
  return { responseHeaders, sid: basename(sessionPath) };
}

/**
 * Drop a session nothing holds once a socket of it closes: one created for this process only (see
 * `GetSessionOptions.socket`), or the guest's when no shell of this process holds it any more. The
 * guest's holds nothing else, and its browser writes it again with its next socket — which may
 * already have, so a guest's session written after `openedAt`, when the closing socket's shell was
 * set up, is another socket's and kept.
 *
 * A signed-in session must survive the socket that used it — the browser will present it again on
 * the next page load — so this reads the node rather than trusting the caller.
 */
export async function releaseSession(config: SessionConfig, sessionPath: NodePath, openedAt: number): Promise<void> {
  try {
    const node = await config.vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);
    const ephemeral = node.attrs.bootId === BOOT_ID;
    const idleGuest = node.attrs.bootId === undefined && isGuest(storedAccess(node.attrs.access)) && node.attrs.createdAt <= openedAt && !sessionHeldByShell(sessionPath);
    if (!ephemeral && !idleGuest) return;
    await config.vfs.unlink(ADMIN_ACCESS, sessionPath, dirname(sessionPath), { recursive: true, readlink: true });
  } catch (err) {
    logger.debug('session release failed', { sessionPath, error: (err as Error).message });
  }
}
