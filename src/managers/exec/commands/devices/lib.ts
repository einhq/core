/**
 * What the device commands share: naming a device or an endpoint, saying a value, keeping a
 * driver's credentials out of its config, a QR code.
 */

import qrcode from 'qrcode-generator';
import { DEVICES_GROUPNAME } from '../../../../lib/access/constants.ts';
import { isAdmin, isVisitor } from '../../../../lib/access/verify-access.ts';
import type { DeviceValue, DriverConfigField } from '../../../../lib/api/devices.ts';
import { groupGid } from '../../../../lib/auth/member-gids.ts';
import { DEV_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';

/** `<device>` or `<device>/<endpoint>`, or either as a path under `/dev`. */
export const parseTarget = (text: string): { device: string; endpoint?: string } | undefined => {
  const rest = text.startsWith(`${DEV_PATH}/`) ? text.slice(DEV_PATH.length + 1) : text;
  const parts = rest.replace(/\/+$/, '').split('/');
  if (parts.length > 2 || parts.some((part) => part === '')) return undefined;
  return { device: parts[0], ...(parts[1] ? { endpoint: parts[1] } : {}) };
};

/** A value as a person writes it, as text: `21.5`, `on`, `off`. */
export const valueText = (value: DeviceValue): string => value === null ? '-' : value === true ? 'on' : value === false ? 'off' : String(value);

/** The user and password an address carries, `scheme://user:password@`. */
const ADDRESS_LOGIN = /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]*)@/gi;

/**
 * Moves the user and password that the config fields named in `given` carry in an address
 * (`http://user:password@host/…`) to the driver's `user` field and its secret `password`, so they
 * are kept in the device's `.secret` and not in config anyone who reads the device sees. The rest of
 * the address is kept as it was written, `{date}` and all. Throws, never saying the password, when
 * the driver keeps no secret password, when the address is not at the start of the value, or when
 * the user or password differs from one given beside it.
 */
export const takeAddressLogins = (
  driver: string,
  fields: DriverConfigField[],
  given: Set<string>,
  config: Record<string, string>,
  secret: Record<string, string>,
): void => {
  const fixed = new Set<string>([...given].filter((name) => name === 'user' || name === 'password'));
  const put = (into: Record<string, string>, name: string, value: string, field: string) => {
    if (fixed.has(name) && into[name] !== value) throw new Error(`the ${name} in ${field} differs from the ${name} given beside it`);
    into[name] = value;
    fixed.add(name);
  };
  const keeps = fields.some((field) => field.name === 'user' && !field.secret) && fields.some((field) => field.name === 'password' && field.secret);
  for (const field of given) {
    const value = config[field];
    if (value === undefined) continue;
    const logins = [...value.matchAll(ADDRESS_LOGIN)];
    if (logins.length === 0) continue;
    if (!keeps) throw new Error(`${driver} keeps no password, so ${field} is given without a user and password in it`);
    const [login] = logins;
    if (logins.length > 1 || login.index !== 0) throw new Error(`${field} carries a user and password inside it: give them as user= and password=`);
    const at = login[2].indexOf(':');
    let user: string, password: string | undefined;
    try {
      user = decodeURIComponent(at < 0 ? login[2] : login[2].slice(0, at));
      password = at < 0 ? undefined : decodeURIComponent(login[2].slice(at + 1));
    } catch {
      throw new Error(`the user and password in ${field} are not understood: give them as user= and password=`);
    }
    config[field] = login[1] + value.slice(login[0].length);
    if (user) put(config, 'user', user, field);
    if (password) put(secret, 'password', password, field);
  }
};

/** A command's failure, said once on stderr. */
export const fail = async (cmd: Command, name: string, error: unknown): Promise<number> => {
  await cmd.writeError(`${name}: ${error instanceof Error ? error.message : error}\n`);
  return 1;
};

/** Refuse anyone but an administrator or a member of the `devices` group who has signed in. */
export const assertDevicesMember = async (cmd: Command): Promise<void> => {
  if (isAdmin(cmd.access)) return;
  // Someone who has not signed in changes nothing, whatever groups their access carries.
  if (isVisitor(cmd.access)) throw new Error('sign in first');
  const gid = await groupGid(cmd.sys.vfs, DEVICES_GROUPNAME);
  if (gid === undefined || !cmd.access.gids.includes(gid)) throw new Error(`only the ${DEVICES_GROUPNAME} group's members make, name and forget devices`);
};

/** `text` as a QR code: an SVG document that scales to whatever box it is drawn in. */
export const qrSvg = (text: string): string => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
};
