/**
 * Drivers and the API they write devices through (`cmd.sys.devices`).
 *
 * A driver turns a device's raw input and output into its endpoints. A module's service registers
 * its drivers when it starts, in core's process, and core calls them while a write waits: `input`
 * for what is written to a device (`/file/dev/<device>`, `cat ride.gpx > /dev/old-etrex`), `write`
 * for a value written to one of its controls. What a driver reads from its devices it appends with
 * `append`, which publishes it on `dev.<device>.<endpoint>` too.
 */

import type { Access } from '../../lib/access/types.ts';
import type { DeviceAttrs, DeviceFix, DeviceValue, DriverConfigField, EndpointAttrs, EndpointType } from '../../lib/api/devices.ts';

/** Raw input written to a device, as its driver is given it. */
export type DriverInput = {
  device: string;
  path: string;
  attrs: DeviceAttrs;
  bytes: Uint8Array;
  /** The type it came with over HTTP; unset from the shell or SFTP. */
  contentType?: string;
  /** The query it came with over HTTP, without `?` or the device's key. */
  query?: string;
  /** Who wrote it: an account's name, or `device:<name>` for a write made with the device's key. */
  by: string;
};

/** A value written to a control, checked against its schema, as its device's driver is given it. */
export type DriverWrite = {
  device: string;
  endpoint: string;
  path: string;
  attrs: DeviceAttrs;
  endpointAttrs: EndpointAttrs;
  value: DeviceValue;
  by: string;
};

/** What a driver answers raw input with: how much it took, and a word for the writer. */
export type DriverAnswer = { taken?: number; message?: string };

/** A driver, as a module's service registers it. */
export type Driver = {
  description: string;
  /** The module that brings it; core's own leave it out. */
  module?: string;
  /** What a person gives when making a device with it (`device-create --config`). */
  config?: DriverConfigField[];
  /** Raw input written to one of its devices; refuses what it cannot read by throwing. */
  input?(raw: DriverInput): Promise<DriverAnswer | void>;
  /** A value written to one of its devices' controls, sent on to the device. */
  write?(command: DriverWrite): Promise<void>;
  /** One of its devices is being forgotten: let go of what would make it again. */
  forget?(device: string): Promise<void>;
};

/** How `append` takes a value: when it was read, and whether the device replayed it. */
export type AppendOptions = { at?: Date; retained?: boolean };

/**
 * What a module sees of core's devices, `cmd.sys.devices`: registering its drivers, and the
 * writes they make. Each takes the caller's access, a service's being the administrator's.
 */
export interface ModuleDevices {
  /** Register `driver` as `name`, in place of one registered before; the answer unregisters it. */
  registerDriver(name: string, driver: Driver): () => void;
  /** The device `name` (`/dev/<name>`), made when it is missing, its attrs set where they differ. Answers its path. */
  ensureDevice(access: Access, name: string, attrs: DeviceAttrs): Promise<string>;
  /**
   * The device's endpoint `name` of `type`, made when it is missing, its attrs set where they
   * differ. `mode` is its mode when made: a reading `0644` unless said, a control `0664` for the
   * users group. Answers its path.
   */
  ensureEndpoint(access: Access, device: string, name: string, type: EndpointType, attrs: EndpointAttrs, mode?: number): Promise<string>;
  /**
   * A value read from the device, for a log or a control, or a fix for a track: appended to the
   * endpoint and published on its key, unless it repeats the last one or a number comes before the
   * endpoint's `minInterval` is over, when it waits for the end of it. Answers whether it was taken now.
   */
  append(access: Access, device: string, endpoint: string, value: DeviceValue | DeviceFix, opts?: AppendOptions): Promise<boolean>;
  /** Fixes for a track endpoint, appended together: a GPX file's, a tracker's buffer. Answers how many were new. */
  appendFixes(access: Access, device: string, endpoint: string, fixes: ({ ts?: string } & DeviceFix)[]): Promise<number>;
  /** The device came or went: its `online` set when it changed, and published on `dev.<device>`. */
  online(access: Access, device: string, up: boolean): Promise<void>;
  /** Remove the device and everything under it, its endpoints' history included. */
  forget(access: Access, device: string): Promise<void>;
}
