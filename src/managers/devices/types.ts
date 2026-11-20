/**
 * Drivers and the API they write devices through (`cmd.sys.devices`).
 *
 * A driver turns a device's raw input and output into its endpoints. A module's service registers
 * its drivers when it starts, in core's process, and core calls them while a write waits: `input`
 * for what a device posts to itself (`/file/dev/<device>`, a webhook's body), `write` for a value
 * written to one of its controls (`echo 30 > /dev/kitchen-speaker/volume`, the paths a screen is to
 * show). What a driver reads from its devices it appends with `append`, which publishes it on `dev.<device>.<endpoint>` too; a stream's bytes, and
 * a stream of pictures' each picture, it writes itself, opening the stream node to write
 * (`StreamWriter`).
 */

import type { Access } from '../../lib/access/types.ts';
import type { DeviceAttrs, DeviceFix, DeviceValue, DriverAnswer, DriverConfigField, EndpointAttrs, EndpointType } from '../../lib/api/devices.ts';

export type { DriverAnswer };

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
  /** The writer's access, for what the driver reads on the writer's behalf. */
  access: Access;
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
  /** The writer's access, for what the driver reads on the writer's behalf: the files a screen is to show. */
  access: Access;
};

/** A driver, as a module's service registers it. */
export type Driver = {
  description: string;
  /** The module that brings it; core's own leave it out. */
  module?: string;
  /** What a person gives when making a device with it (`device-create --config`) or changes later (`device-config`). */
  config?: DriverConfigField[];
  /** Raw input written to one of its devices; refuses what it cannot read by throwing. */
  input?(raw: DriverInput): Promise<DriverAnswer | void>;
  /** A value written to one of its devices' controls, sent on to the device; a word for the writer, when it has one. */
  write?(command: DriverWrite): Promise<{ message?: string } | void>;
  /** One of its devices is being forgotten: let go of what would make it again. */
  forget?(device: string): Promise<void>;
  /**
   * A person made one of its devices (`device-create`) or changed its config (`device-config`): give
   * it the endpoints it has, and take up its config as it is now. Throws what is wrong with the config.
   */
  setup?(device: string): Promise<void>;
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
  /**
   * The device `name` (`/dev/<name>`), made when it is missing (its label the name when none is
   * given), the attrs given set where they differ. A label is the device's from then on, a person's
   * to change (`device-label`): one given for a device already there is left. Answers its path.
   */
  ensureDevice(access: Access, name: string, attrs: Partial<DeviceAttrs>): Promise<string>;
  /**
   * The device's endpoint `name` of `type`, made when it is missing, the attrs given set where they
   * differ, a label only when it is made, as a device's. `mode` is its mode when made, for its
   * device's owner and group, unless said: a reading's and a control's `0660`, a stream's `0640`
   * (its driver writes it), a track's `0770`. A stream's name may have an extension saying what its bytes are (`main.ts`), and
   * its attrs a `mimetype`. Answers its path.
   */
  ensureEndpoint(access: Access, device: string, name: string, type: EndpointType, attrs: EndpointAttrs, mode?: number): Promise<string>;
  /** Remove one endpoint of a device and its history: one the device no longer has, or one of another type now. */
  removeEndpoint(access: Access, device: string, endpoint: string): Promise<void>;
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
  /**
   * What a person gave the device's driver that is secret (`device-create --config` or `device-config`
   * of a field the driver declares `secret`), from the device's `.secret`: empty when there is none. The caller
   * must be the administrator, as a driver's service is.
   */
  secret(access: Access, device: string): Promise<Record<string, string>>;
  /**
   * A ticket for a device on the network, which cannot sign in, to read the file or stream `path`
   * with as `access` would: `/file<path>?ticket=<ticket>` answers that path, and no other, to whoever
   * presents it. It runs out a few minutes after it was made unless it is renewed. Throws when
   * `access` cannot read it.
   */
  fileTicket(access: Access, path: string): Promise<string>;
  /** Keep a file ticket from running out for a few minutes more; false when it already has. */
  renewFileTicket(ticket: string): boolean;
  /** End a file ticket now. */
  dropFileTicket(ticket: string): void;
  /**
   * A path for a browser that cannot sign in, the media service's rendering a page for a screen:
   * opened once within a minute, `/__page/<ticket>` signs it in as `access`, read-only as a share
   * link's visitor reads, and sends it to `route` (a path of this server, `/dashboard-wall/Kitchen`).
   */
  pageSignIn(access: Access, route: string): string;
  /**
   * Serve a live stream to a device on the network, which cannot sign in: `<path>.mp4` and
   * `<path>.ts` answer whoever has the path, its id long and random, with what `open` gives one
   * reader, until `end` or until `open` answers that the stream has ended.
   */
  serveLive(open: LiveOpen): LiveServed;
  /**
   * Serve files made on demand to a device on the network, which cannot sign in, as a set: an HLS
   * playlist and its segments. `<path>/<name>` answers whoever has the path, its id long and random,
   * with what `get(name)` gives, or 404 when it gives nothing, until `end`.
   */
  serveFiles(get: ServedFiles): LiveServed;
}

/** A live stream's two forms: fragmented MP4 (a Cast player's) and MPEG-TS (a DLNA screen's). */
export type LiveFormat = 'mp4' | 'ts';

/**
 * One reader's bytes of a live stream in `format`, cancelled when the reader goes; undefined once
 * the stream has ended for good.
 */
export type LiveOpen = (format: LiveFormat) => Promise<ReadableStream<Uint8Array> | undefined>;

/** One file of a set served to a device: its bytes, or a stream of them, and its media type. */
export type ServedFile = { body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>; type: string };

/**
 * The file `name` of a set served (`index.m3u8`, `12.ts`); undefined when the set has none by that
 * name. Throwing says it cannot be made now, which the reader is told as 503.
 */
export type ServedFiles = (name: string) => Promise<ServedFile | undefined>;

/** A live stream or a set of files served: where (`/live/<id>`, without a format's extension or a name), and how to stop serving it. */
export type LiveServed = { path: string; end(): void };
