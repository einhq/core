/**
 * The EiN app's sign-in, with a token of its own rather than the account's password:
 *
 *   POST /__app/pair      `{ "device": "<phone>", "code": "<pairing code>", "install"? }`, from the
 *                         QR code `device-app --pair` shows: answered `{ token, device, user }`, once.
 *   POST /__app/sign-in   `{ "user", "password", "install", "label"?, "manufacturer"?, "model"?,
 *                         "device"?, "create"? }`: the app signs in with an account's password and
 *                         is paired as the phone `device` names, else as the phone marked with its
 *                         installation, else, with `create`, as a new phone named after `label`.
 *                         Answered `{ token, device, user }`, or 409 `{ phones, create, label }`
 *                         when it must choose: the phones the account may pair and whether it may
 *                         make one.
 *   GET  /__app/session   `Authorization: Bearer <token>`: a Web UI session for the app's WebView,
 *                         its cookie set, and sent on to `?next=` (a path of this server, `/` when
 *                         none).
 *   POST /__app/unpair    `Authorization: Bearer <token>`: the app takes its own pairing away, as
 *                         `device-app --off` does, ending the sessions it opened; answered 204. The
 *                         app's own page cannot do it through its session, which unpairing ends.
 *
 * The token acts as the account that asked for the pairing code or signed in, never the
 * administrator, and may pair only a phone it may change, as `device-app --pair` asks; making a
 * phone is for the devices group's members, as `device-create` is. Each goes through the sign-in
 * throttle, counted against the phone, or the account for a password, and is written to the access
 * log `via app`. A refusal is answered 403 whatever its reason, an unknown phone, a wrong code,
 * password or token, or a disabled account. The installation (`install`, Android's `ANDROID_ID`)
 * is kept on the phone it paired as, so the same app signing in again finds it. The token itself
 * also writes to the phone's endpoints (`dev-write.ts`).
 */

import { appAccess, findAppToken, markAppInstall, pairApp, pairAppAs, readDeviceApp, removeDeviceApp, touchAppToken } from '../../../managers/devices/app-tokens.ts';
import { ADMIN_ACCESS, ADMIN_UID, DEVICES_GROUPNAME } from '../../../lib/access/constants.ts';
import type { Access } from '../../../lib/access/types.ts';
import { verifyAccess } from '../../../lib/access/verify-access.ts';
import { type DeviceAttrs, deviceName } from '../../../lib/api/devices.ts';
import { passwordSignIn, SignInFailedError } from '../../../lib/auth/account-password.ts';
import { accountOfUid } from '../../../lib/auth/display-account.ts';
import { groupGid } from '../../../lib/auth/member-gids.ts';
import { signInThrottle } from '../../../lib/auth/sign-in-throttle.ts';
import { DEV_PATH, devicePath } from '../../../lib/paths.ts';
import { isDeviceName } from '../../../managers/devices/mod.ts';
import { type DeviceNodeAttrs, NODE_TYPE_DEVICE } from '../../../vfs/types/device.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { recordAccess } from '../../../vfs/mod.ts';
import { BodyTooLargeError, readBody, tooLarge } from '../body-limit.ts';
import { openAppSession } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-app');

/** The most a pairing or sign-in request may send: a phone's name and a code, or a password and what the phone says of itself. */
const PAIR_BODY_LIMIT = 4096;

/** An installation as the app names it: Android's `ANDROID_ID`, 16 hex digits, or whatever else of its shape. */
const INSTALL_RE = /^[A-Za-z0-9._-]{1,128}$/;

const NO_STORE = { 'Cache-Control': 'no-store' };

const refused = (message: string): Response => new Response(`${message}\n`, { status: 403, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });

/** What the throttle counts the app's attempts at a phone against: no account is named before the code or token is checked. */
const throttleKey = (device: string): string => `app:${device}`;

/** `next` when it is a path of this server, else `/`: never another site. */
const sameSitePath = (next: string | null): string => next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';

export async function handleAppPair(config: HttpServerConfig, req: Request, from: string | undefined): Promise<Response> {
  let device: unknown;
  let code: unknown;
  let install: unknown;
  try {
    ({ device, code, install } = JSON.parse(new TextDecoder().decode(await readBody(req, PAIR_BODY_LIMIT))) ?? {});
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge(error, NO_STORE);
    return new Response('send { "device": "<phone>", "code": "<pairing code>" } as JSON\n', { status: 400, headers: NO_STORE });
  }
  if (typeof device !== 'string' || typeof code !== 'string' || !isDeviceName(device) || !isInstall(install)) {
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
  if (install !== undefined) await markAppInstall(config.vfs, device, install);
  await recordAccess(config.vfs, { event: 'sign-in', uid: access.uid, from, via: 'app', method: 'pairing' });
  const user = (await accountOfUid(config.vfs, access.uid))?.username;
  return new Response(JSON.stringify({ token: paired.token, device, user }), { headers: { ...NO_STORE, 'Content-Type': 'application/json' } });
}

const isInstall = (value: unknown): value is string | undefined => value === undefined || (typeof value === 'string' && INSTALL_RE.test(value));

/** What the app sends to sign in with a password, and what it says of the phone it runs on. */
type SignInRequest = {
  user: string;
  password: string;
  install: string;
  label?: string;
  manufacturer?: string;
  model?: string;
  device?: string;
  create?: boolean;
};

const SIGN_IN_USAGE = 'send { "user", "password", "install", "label"?, "manufacturer"?, "model"?, "device"?, "create"? } as JSON\n';

/** A sign-in request as the app sends it; undefined when it is not one. */
const signInRequest = (body: unknown): SignInRequest | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { user, password, install, label, manufacturer, model, device, create } = body as Record<string, unknown>;
  const text = (value: unknown): value is string | undefined => value === undefined || (typeof value === 'string' && value.length <= 200);
  if (typeof user !== 'string' || typeof password !== 'string' || typeof install !== 'string' || !INSTALL_RE.test(install)) return undefined;
  if (!text(label) || !text(manufacturer) || !text(model) || !text(device) || (device !== undefined && !isDeviceName(device))) return undefined;
  if (create !== undefined && typeof create !== 'boolean') return undefined;
  return { user, password, install, label, manufacturer, model, device, create };
};

/** A phone the app may be paired as: its name, what it is called, and whether an app is paired with it now. */
type PhoneChoice = { device: string; label: string; paired: boolean };

/**
 * The devices `access` may pair the app with, those it may change, read as the administrator: all
 * of them, each with what it says of itself.
 */
const pairableDevices = async (config: HttpServerConfig, access: Access): Promise<{ name: string; attrs: DeviceAttrs }[]> => {
  const children = await config.vfs.children<DeviceNodeAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []);
  return children.filter(({ node }) => node.type === NODE_TYPE_DEVICE && verifyAccess(access, node.props, 'w')).map(({ name, node }) => ({ name, attrs: node.attrs }));
};

/** A device name made from `label` that no node in /dev has yet. */
const freeDeviceName = async (config: HttpServerConfig, label: string): Promise<string | undefined> => {
  const base = deviceName(label).slice(0, 56) || 'phone';
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (isDeviceName(name) && !await config.vfs.exists(ADMIN_ACCESS, devicePath(name))) return name;
  }
  return undefined;
};

export async function handleAppSignIn(config: HttpServerConfig, req: Request, from: string | undefined): Promise<Response> {
  let request: SignInRequest | undefined;
  try {
    request = signInRequest(JSON.parse(new TextDecoder().decode(await readBody(req, PAIR_BODY_LIMIT))));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge(error, NO_STORE);
  }
  if (!request) return new Response(SIGN_IN_USAGE, { status: 400, headers: NO_STORE });

  // The password's check is every password sign-in's: its throttle, by the account, and its time.
  let username: string;
  let uid: number;
  try {
    const account = await passwordSignIn(config.vfs, request.user, request.password, { env: config.env, from });
    ({ username } = account);
    uid = account.userNode.attrs.uid;
  } catch (error) {
    if (!(error instanceof SignInFailedError)) throw error;
    logger.warn('app sign-in refused', { from, reason: error.message });
    await recordAccess(config.vfs, { event: 'sign-in-failed', uid: error.uid, reason: error.message, from, via: 'app', method: 'password' });
    return refused(error.message);
  }
  const access = uid === ADMIN_UID ? undefined : await appAccess(config.vfs, uid);
  if (!access) {
    const reason = uid === ADMIN_UID ? "the app never acts as the administrator: sign in as the phone's person" : 'this account may not sign in';
    await recordAccess(config.vfs, { event: 'sign-in-failed', uid, reason, from, via: 'app', method: 'password' });
    return refused(reason);
  }

  const devices = await pairableDevices(config, access);
  const label = request.label?.trim() || [request.manufacturer, request.model].filter(Boolean).join(' ') || `${username}'s phone`;
  let device = request.device ?? devices.find(({ attrs }) => attrs.install === request.install)?.name;
  if (request.device && !devices.some(({ name }) => name === request.device)) {
    const reason = `${request.device} is not a device ${username} may pair the app with`;
    await recordAccess(config.vfs, { event: 'sign-in-failed', uid, reason, from, via: 'app', method: 'password' });
    return refused(reason);
  }
  const mayCreate = config.devices !== undefined && access.gids.includes(await groupGid(config.vfs, DEVICES_GROUPNAME) ?? -1);
  if (!device && request.create && mayCreate) {
    device = await freeDeviceName(config, label);
    if (!device) return refused(`no free device name is made from '${label}': choose another`);
    const attrs: DeviceAttrs = {
      label,
      class: 'phone',
      driver: 'tracker',
      ...(request.manufacturer ? { manufacturer: request.manufacturer } : {}),
      ...(request.model ? { model: request.model } : {}),
    };
    // Made as the administrator, since /dev is theirs, and the devices group's as every device is: as device-create does.
    await config.devices!.ensureDevice(ADMIN_ACCESS, device, attrs);
    await config.devices!.driver('tracker')?.setup?.(device);
    logger.info('app sign-in made a phone', { device, user: username });
  }
  if (!device) {
    const phones: PhoneChoice[] = [];
    for (const { name, attrs } of devices.filter(({ attrs }) => attrs.class === 'phone')) {
      phones.push({ device: name, label: attrs.label || name, paired: (await readDeviceApp(config.vfs, name))?.attrs.token !== undefined });
    }
    return new Response(JSON.stringify({ phones, create: mayCreate, label }), { status: 409, headers: { ...NO_STORE, 'Content-Type': 'application/json' } });
  }

  const token = await pairAppAs(config.vfs, device, uid);
  if (!token) return refused(`${device} is being paired just now: try again`);
  await markAppInstall(config.vfs, device, request.install);
  await recordAccess(config.vfs, { event: 'sign-in', uid, from, via: 'app', method: 'password' });
  return new Response(JSON.stringify({ token, device, user: username }), { headers: { ...NO_STORE, 'Content-Type': 'application/json' } });
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
