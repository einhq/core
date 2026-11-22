/**
 * The EiN app's sign-in, with a token of its own rather than the account's password:
 *
 *   POST /__app/pair      `{ "device": "<phone>", "code": "<pairing code>" }`, from the QR code
 *                         `device-app --pair` shows: answered `{ token, device, user }`, once.
 *   GET  /__app/session   `Authorization: Bearer <token>`: a Web UI session for the app's WebView,
 *                         its cookie set, and sent on to `?next=` (a path of this server, `/` when
 *                         none).
 *   POST /__app/unpair    `Authorization: Bearer <token>`: the app takes its own pairing away, as
 *                         `device-app --off` does, ending the sessions it opened; answered 204. The
 *                         app's own page cannot do it through its session, which unpairing ends.
 *
 * The token acts as the account that asked for the pairing code. Each goes through the sign-in
 * throttle, counted against the phone, and is written to the access log `via app`. A refusal is
 * answered 403 whatever its reason, an unknown phone, a wrong code or token, or a disabled account.
 * The token itself also writes to the phone's endpoints (`dev-write.ts`).
 */

import { appAccess, findAppToken, pairApp, readDeviceApp, removeDeviceApp, touchAppToken } from '../../../managers/devices/app-tokens.ts';
import { accountOfUid } from '../../../lib/auth/display-account.ts';
import { signInThrottle } from '../../../lib/auth/sign-in-throttle.ts';
import { isDeviceName } from '../../../managers/devices/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { recordAccess } from '../../../vfs/mod.ts';
import { BodyTooLargeError, readBody, tooLarge } from '../body-limit.ts';
import { openAppSession } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-app');

/** The most a pairing request may send: a phone's name and a code. */
const PAIR_BODY_LIMIT = 4096;

const NO_STORE = { 'Cache-Control': 'no-store' };

const refused = (message: string): Response => new Response(`${message}\n`, { status: 403, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });

/** What the throttle counts the app's attempts at a phone against: no account is named before the code or token is checked. */
const throttleKey = (device: string): string => `app:${device}`;

/** `next` when it is a path of this server, else `/`: never another site. */
const sameSitePath = (next: string | null): string => next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';

export async function handleAppPair(config: HttpServerConfig, req: Request, from: string | undefined): Promise<Response> {
  let device: unknown;
  let code: unknown;
  try {
    ({ device, code } = JSON.parse(new TextDecoder().decode(await readBody(req, PAIR_BODY_LIMIT))) ?? {});
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge(error, NO_STORE);
    return new Response('send { "device": "<phone>", "code": "<pairing code>" } as JSON\n', { status: 400, headers: NO_STORE });
  }
  if (typeof device !== 'string' || typeof code !== 'string' || !isDeviceName(device)) {
    return new Response('send { "device": "<phone>", "code": "<pairing code>" } as JSON\n', { status: 400, headers: NO_STORE });
  }

  const attempt = await signInThrottle.begin(throttleKey(device), from).catch((error: Error) => error);
  if (attempt instanceof Error) return refused(attempt.message);
  // Whoever the code was made for learns that someone tried it, in their access log.
  const waiting = (await readDeviceApp(config.vfs, device))?.attrs.pairing?.by;
  const paired = await pairApp(config.vfs, device, code);
  const access = paired && await appAccess(config.vfs, paired.by);
  if (!paired || !access) {
    if (paired) await removeDeviceApp(config.vfs, device);
    await attempt.failed();
    const reason = 'not a pairing code of this phone, or it has run out';
    logger.warn('app pairing refused', { device, from });
    await recordAccess(config.vfs, { event: 'sign-in-failed', uid: waiting, reason, from, via: 'app', method: 'pairing' });
    return refused(reason);
  }
  attempt.succeeded();
  await recordAccess(config.vfs, { event: 'sign-in', uid: access.uid, from, via: 'app', method: 'pairing' });
  const user = (await accountOfUid(config.vfs, access.uid))?.username;
  return new Response(JSON.stringify({ token: paired.token, device, user }), { headers: { ...NO_STORE, 'Content-Type': 'application/json' } });
}

/** The app token a request carries as `Authorization: Bearer`, with the phone it names, when it names one. */
const bearerOf = (req: Request): { token: string; device: string } | undefined => {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const device = token?.split('.')[0];
  return token && device && isDeviceName(device) ? { token, device } : undefined;
};

export async function handleAppSession(config: HttpServerConfig, req: Request, url: URL, from: string | undefined): Promise<Response> {
  const bearer = bearerOf(req);
  if (!bearer) return refused('send the app token as Authorization: Bearer <token>');
  const { token, device } = bearer;

  const attempt = await signInThrottle.begin(throttleKey(device), from).catch((error: Error) => error);
  if (attempt instanceof Error) return refused(attempt.message);
  const found = await findAppToken(config.vfs, token);
  const access = found && await appAccess(config.vfs, found.by);
  if (!found || !access) {
    await attempt.failed();
    const reason = found ? 'the account the app was paired as may not sign in' : 'not the token of a paired phone';
    logger.warn('app session refused', { device, from, reason });
    await recordAccess(config.vfs, { event: 'sign-in-failed', uid: found?.by, reason, from, via: 'app', method: 'token' });
    return refused(reason);
  }
  attempt.succeeded();
  const app = { device: found.device, id: found.id };
  const { responseHeaders, sid } = await openAppSession(config, req.headers, access, app);
  await recordAccess(config.vfs, { event: 'sign-in', uid: access.uid, sid, from, via: 'app', method: 'token' });
  await touchAppToken(config.vfs, app, from);
  responseHeaders.set('Location', sameSitePath(url.searchParams.get('next')));
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(null, { status: 303, headers: responseHeaders });
}

export async function handleAppUnpair(config: HttpServerConfig, req: Request, from: string | undefined): Promise<Response> {
  const bearer = bearerOf(req);
  if (!bearer) return refused('send the app token as Authorization: Bearer <token>');
  const attempt = await signInThrottle.begin(throttleKey(bearer.device), from).catch((error: Error) => error);
  if (attempt instanceof Error) return refused(attempt.message);
  const found = await findAppToken(config.vfs, bearer.token);
  if (!found) {
    await attempt.failed();
    const reason = 'not the token of a paired phone';
    logger.warn('app unpairing refused', { device: bearer.device, from });
    await recordAccess(config.vfs, { event: 'sign-in-failed', reason, from, via: 'app', method: 'token' });
    return refused(reason);
  }
  attempt.succeeded();
  await removeDeviceApp(config.vfs, found.device);
  await recordAccess(config.vfs, { event: 'sign-out', uid: found.by, from, via: 'app', method: 'token' });
  return new Response(null, { status: 204, headers: NO_STORE });
}
