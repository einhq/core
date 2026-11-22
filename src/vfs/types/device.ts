import type { DeviceAttrs, EndpointAttrs } from '../../lib/api/devices.ts';
import type { UserId } from '../../lib/mode/mod.ts';
import type { Node, NodeAttrs, NodeType } from '../node.ts';
import type { LogAttrs } from './log.ts';

/** A device: `/dev/<device>`, its endpoints as children. What is written to it is raw input for its driver. */
export const NODE_TYPE_DEVICE: NodeType = 'device';

/**
 * A control: an endpoint written to change the device, a switch or a setpoint. What is written to
 * it goes to the device's driver; what is read from it are the states the device reported, which
 * its driver appends.
 */
export const NODE_TYPE_CONTROL: NodeType = 'control';

/** The key a device's HTTP writes carry, its child `.key`: mode 0600 and the administrator's. */
export const NODE_TYPE_DEVICE_KEY: NodeType = 'device-key';

export type DeviceNodeAttrs = NodeAttrs & DeviceAttrs;

export type ControlAttrs = LogAttrs & EndpointAttrs;

export type DeviceKeyAttrs = NodeAttrs & {
  key: string;
  createdBy: UserId;
  createdAt: number;
};

/**
 * The EiN app's pairing with a phone, its child `.app`: mode 0600 and the administrator's. It holds a
 * pairing code waiting for the app, the token the app was given, or both.
 */
export const NODE_TYPE_DEVICE_APP: NodeType = 'device-app';

export type DeviceAppAttrs = NodeAttrs & {
  /** A one-time code the app trades for a token, until `expiresAt`; kept as its SHA-256. */
  pairing?: { hash: string; expiresAt: number; by: UserId; createdAt: number };
  /**
   * The token the app holds, kept as its SHA-256: `id` names it in the sessions it opens, `by` is
   * the account it acts as, whoever asked for the pairing code.
   */
  token?: { id: string; hash: string; by: UserId; pairedAt: number; lastUsedAt?: number; lastFrom?: string };
};

/** Whether a node is an app's pairing with a phone. */
export const isDeviceAppNode = (node: Node): node is Node<DeviceAppAttrs> => node.type === NODE_TYPE_DEVICE_APP;

/** Whether a node is a device key: a `device-key` node with its key. */
export const isDeviceKeyNode = (node: Node): node is Node<DeviceKeyAttrs> => node.type === NODE_TYPE_DEVICE_KEY && typeof node.attrs.key === 'string';
