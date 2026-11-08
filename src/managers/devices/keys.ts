/**
 * A device's key: what lets the device itself write to `/file/dev/<device>` without signing in, as a
 * phone posting its position does. Kept as the device's child `.key`, mode 0600 and the
 * administrator's, so `device-key` can show the URL again to whoever may change the device.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/constants.ts';
import { DEVICE_KEY_NAME, devicePath } from '../../lib/paths.ts';
import { newToken, sameToken } from '../../lib/token/mod.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { Node } from '../../vfs/node.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import { type DeviceKeyAttrs, isDeviceKeyNode, NODE_TYPE_DEVICE_KEY } from '../../vfs/types/device.ts';

/** The device's key, read as the administrator; undefined when it has none. */
export const readDeviceKey = async (vfs: ModuleVFS, device: string): Promise<Node<DeviceKeyAttrs> | undefined> => {
  try {
    const node = await vfs.get<DeviceKeyAttrs>(ADMIN_ACCESS, join(devicePath(device), DEVICE_KEY_NAME));
    return isDeviceKeyNode(node) ? node : undefined;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

/** Whether `key` is the device's. */
export const isDeviceKey = async (vfs: ModuleVFS, device: string, key: string): Promise<boolean> => {
  const record = await readDeviceKey(vfs, device);
  return record !== undefined && sameToken(record.attrs.key, key);
};

/** Give the device a new key, in place of any before it, made in the name of `by`. */
export const newDeviceKey = async (vfs: ModuleVFS, device: string, by: number): Promise<Node<DeviceKeyAttrs>> => {
  await removeDeviceKey(vfs, device);
  const attrs: DeviceKeyAttrs = { key: newToken(), createdBy: by, createdAt: Date.now() };
  return await vfs.create<DeviceKeyAttrs>(ADMIN_ACCESS, NODE_TYPE_DEVICE_KEY, devicePath(device), DEVICE_KEY_NAME, { props: { mode: 0o600 }, attrs });
};

/** Take the device's key away; its URL stops working at once. */
export const removeDeviceKey = async (vfs: ModuleVFS, device: string): Promise<void> => {
  if (await readDeviceKey(vfs, device)) await vfs.unlink(ADMIN_ACCESS, join(devicePath(device), DEVICE_KEY_NAME), devicePath(device));
};
