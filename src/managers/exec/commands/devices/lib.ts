/** What the device commands share: naming a device or an endpoint, saying a value, a QR code. */

import qrcode from 'qrcode-generator';
import { DEVICES_GROUPNAME } from '../../../../lib/access/constants.ts';
import { isAdmin } from '../../../../lib/access/verify-access.ts';
import type { DeviceValue } from '../../../../lib/api/devices.ts';
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

/** A command's failure, said once on stderr. */
export const fail = async (cmd: Command, name: string, error: unknown): Promise<number> => {
  await cmd.writeError(`${name}: ${error instanceof Error ? error.message : error}\n`);
  return 1;
};

/** Refuse anyone but an administrator or a member of the `devices` group. */
export const assertDevicesMember = async (cmd: Command): Promise<void> => {
  if (isAdmin(cmd.access)) return;
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
