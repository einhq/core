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

/**
 * A stream: an endpoint that is a device's live picture, a camera's. Nothing keeps it: reading it
 * gives one frame from the device's driver, and its driver says where to watch it live.
 */
export const NODE_TYPE_STREAM: NodeType = 'stream';

/** The key a device's HTTP writes carry, its child `.key`: mode 0600 and the administrator's. */
export const NODE_TYPE_DEVICE_KEY: NodeType = 'device-key';

export type DeviceNodeAttrs = NodeAttrs & DeviceAttrs;

export type ControlAttrs = LogAttrs & EndpointAttrs;

export type StreamAttrs = NodeAttrs & EndpointAttrs;

export type DeviceKeyAttrs = NodeAttrs & {
  key: string;
  createdBy: UserId;
  createdAt: number;
};

/** Whether a node is a device key: a `device-key` node with its key. */
export const isDeviceKeyNode = (node: Node): node is Node<DeviceKeyAttrs> => node.type === NODE_TYPE_DEVICE_KEY && typeof node.attrs.key === 'string';
