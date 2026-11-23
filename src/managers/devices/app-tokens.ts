/**
 * The EiN app's pairing with a phone: a person shows a QR code on the phone's device page, which
 * holds a one-time pairing code, and the app trades the code for a token of its own; or the app
 * signs in once with the account's password and is given the token at once (`pairAppAs`). The
 * token acts as whoever asked for the code or signed in, never as the administrator: it posts to
 * the phone's own endpoints and opens Web UI sessions for the app, which keeps no password.
 *
 * Kept as the phone's child `.app`, mode 0600 and the administrator's. Codes and tokens are kept as
 * their SHA-256 alone: neither is shown again once given. The token is `<device>.<secret>`, so a
 * request names the phone it was paired with by the token alone. A phone has one token: a new
 * pairing replaces it, withdrawing it removes `.app`, and so does forgetting the phone; each ends
 * the sessions the token it replaced or removed had opened (`endAppSessions`).
 */

import { encodeHex } from '@std/encoding/hex';
import { join } from '@std/path';
import { ulid } from '@std/ulid';
import { ADMIN_ACCESS, ADMIN_UID } from '../../lib/access/constants.ts';
import type { Access } from '../../lib/access/types.ts';
import { accessOfUid } from '../../lib/auth/member-gids.ts';
import type { UserId } from '../../lib/mode/mod.ts';
import { DEV_PATH, DEVICE_APP_NAME, devicePath, SESSIONS_PATH } from '../../lib/paths.ts';
import { isToken, newToken, sameToken } from '../../lib/token/mod.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { Node } from '../../vfs/node.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import { type DeviceAppAttrs, type DeviceNodeAttrs, isDeviceAppNode, NODE_TYPE_DEVICE, NODE_TYPE_DEVICE_APP } from '../../vfs/types/device.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../vfs/types/session.ts';

/** How long a pairing code works: long enough to install the app and scan it. */
const PAIRING_MINUTES = 15;

/** How stale a token's `lastUsedAt` may get, so a phone posting every few seconds writes it once a minute. */
const LAST_USE_FLOOR_MS = 60_000;

/** What a session opened with an app token names, so it ends when the token is withdrawn. */
export type AppSession = { device: string; id: string };

/** The phone's pairing with the app, read as the administrator; undefined when it has none. */
export const readDeviceApp = async (vfs: ModuleVFS, device: string): Promise<Node<DeviceAppAttrs> | undefined> => {
  try {
    const node = await vfs.get<DeviceAppAttrs>(ADMIN_ACCESS, join(devicePath(device), DEVICE_APP_NAME));
    return isDeviceAppNode(node) ? node : undefined;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

const sha256 = async (text: string): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

const appPath = (device: string): string => join(devicePath(device), DEVICE_APP_NAME);

/**
 * The access the app acts with for `uid`: the account's as it signs in, never elevated; undefined
 * for the administrator and for an account that is gone or disabled.
 */
export const appAccess = async (vfs: ModuleVFS, uid: UserId): Promise<Access | undefined> => uid === ADMIN_UID ? undefined : await accessOfUid(vfs, uid);

/**
 * A new pairing code for the phone, made by `by`, in place of any code before it. A token the app
 * already holds keeps working until the code is used.
 */
export const newPairingCode = async (vfs: ModuleVFS, device: string, by: UserId, now = Date.now()): Promise<{ code: string; expiresAt: number }> => {
  const code = newToken();
  const pairing = { hash: await sha256(code), expiresAt: now + PAIRING_MINUTES * 60_000, by, createdAt: now };
  if (await readDeviceApp(vfs, device)) await vfs.update<DeviceAppAttrs>(ADMIN_ACCESS, appPath(device), { attrs: { pairing } });
  else await vfs.create<DeviceAppAttrs>(ADMIN_ACCESS, NODE_TYPE_DEVICE_APP, devicePath(device), DEVICE_APP_NAME, { props: { mode: 0o600, tier: 'db' }, attrs: { pairing } });
  return { code, expiresAt: pairing.expiresAt };
};

/** Phones a pairing is being made for now, so one code pairs once when two requests bring it at the same time. */
const trading = new Set<string>();

/**
 * Trade the phone's pairing code for its token, once: the code goes, and a token the phone had
 * before is replaced. Undefined when `code` is not the phone's code or it has run out.
 */
export const pairApp = async (vfs: ModuleVFS, device: string, code: string, now = Date.now()): Promise<{ token: string; by: UserId } | undefined> => {
  if (!isToken(code) || trading.has(device)) return undefined;
  trading.add(device);
  try {
    const record = await readDeviceApp(vfs, device);
    const wanted = record?.attrs.pairing;
    if (!wanted || wanted.expiresAt <= now || !sameToken(wanted.hash, await sha256(code))) return undefined;
    return { token: await giveToken(vfs, device, wanted.by, now), by: wanted.by };
  } finally {
    trading.delete(device);
  }
};

/**
 * Pair the phone with the app as `by`, who signed in with a password and may change the phone: a
 * code waiting for it goes, and a token the phone had before is replaced. Undefined while another
 * pairing of the phone is being made.
 */
export const pairAppAs = async (vfs: ModuleVFS, device: string, by: UserId, now = Date.now()): Promise<string | undefined> => {
  if (trading.has(device)) return undefined;
  trading.add(device);
  try {
    return await giveToken(vfs, device, by, now);
  } finally {
    trading.delete(device);
  }
};

/** A new token for the phone, acting as `by`, in place of its code and token; the sessions the old token opened end. */
const giveToken = async (vfs: ModuleVFS, device: string, by: UserId, now: number): Promise<string> => {
  const token = `${device}.${newToken()}`;
  const id = ulid();
  const held = { id, hash: await sha256(token), by, pairedAt: now };
  if (await readDeviceApp(vfs, device)) await vfs.update<DeviceAppAttrs>(ADMIN_ACCESS, appPath(device), { attrs: { pairing: null, token: held } });
  else {await vfs.create<DeviceAppAttrs>(ADMIN_ACCESS, NODE_TYPE_DEVICE_APP, devicePath(device), DEVICE_APP_NAME, {
      props: { mode: 0o600, tier: 'db' },
      attrs: { token: held },
    });}
  await endAppSessions(vfs, device, id);
  return token;
};

/**
 * Mark the phone as the one the app installation `install` is paired with (its `install` attribute),
 * and no other device as it, so a sign-in from the same installation finds it again.
 */
export const markAppInstall = async (vfs: ModuleVFS, device: string, install: string): Promise<void> => {
  for (const { name, node } of await vfs.children<DeviceNodeAttrs>(ADMIN_ACCESS, DEV_PATH)) {
    if (node.type !== NODE_TYPE_DEVICE) continue;
    if (name === device && node.attrs.install !== install) await vfs.update<DeviceNodeAttrs>(ADMIN_ACCESS, devicePath(name), { attrs: { install } });
    else if (name !== device && node.attrs.install === install) await vfs.update<DeviceNodeAttrs>(ADMIN_ACCESS, devicePath(name), { attrs: { install: null } });
  }
};

/** The phone a token names, read from it before anything is looked up; undefined for one that is not an app token's shape. */
export const appTokenDevice = (token: string): string | undefined => {
  const dot = token.indexOf('.');
  return dot > 0 && isToken(token.slice(dot + 1)) ? token.slice(0, dot) : undefined;
};

/** The phone and token `token` is, while the phone holds it; undefined otherwise. */
export const findAppToken = async (vfs: ModuleVFS, token: string): Promise<{ device: string; id: string; by: UserId } | undefined> => {
  const device = appTokenDevice(token);
  if (!device) return undefined;
  const held = (await readDeviceApp(vfs, device))?.attrs.token;
  if (!held || !sameToken(held.hash, await sha256(token))) return undefined;
  return { device, id: held.id, by: held.by };
};

/** Whether the token a session was opened with is still the phone's. */
export const appSessionHolds = async (vfs: ModuleVFS, session: AppSession): Promise<boolean> => (await readDeviceApp(vfs, session.device))?.attrs.token?.id === session.id;

/** Note that the phone's token was used just now, from `from` when known; at most once a minute. */
export const touchAppToken = async (vfs: ModuleVFS, session: AppSession, from?: string, now = Date.now()): Promise<void> => {
  const held = (await readDeviceApp(vfs, session.device))?.attrs.token;
  if (!held || held.id !== session.id) return;
  if (now - (held.lastUsedAt ?? 0) < LAST_USE_FLOOR_MS) return;
  await vfs.update<DeviceAppAttrs>(ADMIN_ACCESS, appPath(session.device), {
    attrs: { token: { ...held, lastUsedAt: now, ...(from !== undefined ? { lastFrom: from } : {}) } },
  });
};

/**
 * End the sessions an app opened with a token of the phone's other than `keep`: they are removed,
 * so a cookie naming one is refused and the shells and sockets bound to it close.
 */
export const endAppSessions = async (vfs: ModuleVFS, device: string, keep?: string): Promise<void> => {
  const sessions = await vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH).catch(() => []);
  for (const { name, node } of sessions) {
    if (node.type !== NODE_TYPE_SESSION || node.attrs.app?.device !== device || node.attrs.app.id === keep) continue;
    await vfs.unlink(ADMIN_ACCESS, join(SESSIONS_PATH, name), SESSIONS_PATH, { recursive: true, readlink: true }).catch(() => {});
  }
};

/** Take the app's pairing away, a code waiting for it too: the token and the sessions it opened stop working at once. */
export const removeDeviceApp = async (vfs: ModuleVFS, device: string): Promise<void> => {
  if (await readDeviceApp(vfs, device)) await vfs.unlink(ADMIN_ACCESS, appPath(device), devicePath(device));
  await endAppSessions(vfs, device);
};
