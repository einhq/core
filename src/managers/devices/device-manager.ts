/**
 * Core's devices: the drivers modules register, what is written to a device or a control handed to
 * its driver, and the writes drivers make to devices and their endpoints.
 *
 * A device is `/dev/<device>`, its endpoints the `log`, `track` and `control` nodes under it. What a
 * driver reads from a device it appends through `append`, which keeps it on the endpoint (through
 * the VFS, so a track's change reaches those who follow it) and publishes it on
 * `dev.<device>.<endpoint>`, for queues and rules. The VFS gives writes to devices and controls to
 * `input` and `command` here (`DeviceSink`), and so does the HTTP server.
 */

import { basename, dirname, join } from '@std/path';
import { ADMIN_ACCESS, DEVICES_GROUPNAME, USERS_GID } from '../../lib/access/constants.ts';
import type { Access } from '../../lib/access/types.ts';
import { type DeviceAttrs, type DeviceFix, type DeviceMessage, deviceRoutingKey, type DeviceValue, type EndpointAttrs, type EndpointType } from '../../lib/api/devices.ts';
import { groupGid } from '../../lib/auth/member-gids.ts';
import { createLogger } from '../logger/mod.ts';
import { readTail } from '../../lib/metrics/read.ts';
import { DEV_PATH, DEV_RESERVED_NAMES, devicePath, USERS_PATH } from '../../lib/paths.ts';
import { readTrackerRequest } from '../../lib/track/tracker-protocols.ts';
import { LogHandle } from '../../registries/log/log-handle.ts';
import { TrackHandle } from '../../registries/track/track-handle.ts';
import { assertAccess } from '../../vfs/assert-access.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { DeviceSink } from '../../vfs/types.ts';
import { type ControlAttrs, type DeviceNodeAttrs, NODE_TYPE_CONTROL, NODE_TYPE_DEVICE } from '../../vfs/types/device.ts';
import { NODE_TYPE_LOG } from '../../vfs/types/log.ts';
import { isUserNode } from '../../vfs/types/user.ts';
import type { RouterManagerIf } from '../router/mod.ts';
import { ControlValueError, parseControlValue } from './control-value.ts';
import { decide, type Published } from './throttle.ts';
import type { AppendOptions, Driver, DriverAnswer, ModuleDevices } from './types.ts';

const logger = createLogger('devices');

/** How long a control's write waits for its driver before it is answered that the device did not. */
const WRITE_TIMEOUT_MS = 10_000;

/** A device's or endpoint's name: lower-case letters, digits and dashes, as a slug is. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A write to a device that cannot be done as asked: no driver, one not running, a value refused. */
export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceError';
  }
}

/** Whether `name` may be a device's: a slug, and none of core's own nodes in `/dev`. */
export const isDeviceName = (name: string): boolean => NAME_RE.test(name) && !DEV_RESERVED_NAMES.includes(name);

const assertName = (what: string, name: string): void => {
  if (!NAME_RE.test(name)) throw new DeviceError(`${what} '${name}' is not a name: lower-case letters, digits, - and _`);
  if (what === 'device' && DEV_RESERVED_NAMES.includes(name)) throw new DeviceError(`'${name}' is core's own in ${DEV_PATH}, not a device's name`);
};

const isFix = (value: unknown): value is DeviceFix =>
  typeof value === 'object' && value !== null && typeof (value as DeviceFix).lat === 'number' && typeof (value as DeviceFix).lng === 'number';

/** The attrs of `wanted` that `current` does not already have, or undefined when it has them all. */
const changedAttrs = (current: Record<string, unknown>, wanted: Record<string, unknown>): Record<string, unknown> | undefined => {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
};

type Endpoint = { path: string; type: EndpointType; attrs: EndpointAttrs; readAt: number };

/** How long an endpoint's attrs are taken as read: a changed `minInterval` counts from then on. */
const ENDPOINT_TTL_MS = 60_000;
type Pending = { timer: ReturnType<typeof setTimeout>; value: DeviceValue; at: Date; retained?: boolean; access: Access };

export class DeviceManager implements DeviceSink, ModuleDevices {
  private readonly drivers = new Map<string, Driver>();
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly published = new Map<string, Published>();
  private readonly pending = new Map<string, Pending>();
  private readonly names = new Map<number, string>();

  constructor(private readonly sys: { vfs: NodeVFS; routerManager: RouterManagerIf }) {
    this.registerDriver('tracker', trackerDriver(this));
  }

  /** Stop what waits to be published. */
  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  // ===== Drivers =====

  registerDriver(name: string, driver: Driver): () => void {
    assertName('driver', name);
    this.drivers.set(name, driver);
    return () => {
      if (this.drivers.get(name) === driver) this.drivers.delete(name);
    };
  }

  /** The driver registered as `name`, while its service runs. */
  driver(name: string): Driver | undefined {
    return this.drivers.get(name);
  }

  /** The names of the drivers registered now, core's included. */
  driverNames(): string[] {
    return [...this.drivers.keys()].sort();
  }

  // ===== What is written to devices and controls =====

  async input(access: Access, path: string, raw: { bytes: Uint8Array; contentType?: string; query?: string; by?: string }): Promise<DriverAnswer> {
    const node = await this.sys.vfs.get<DeviceNodeAttrs>(access, path);
    if (node.type !== NODE_TYPE_DEVICE || dirname(path) !== DEV_PATH) throw new DeviceError(`${path}: not a device`);
    assertAccess(access, node, 'w');
    const device = basename(path);
    const name = node.attrs.driver;
    if (!name) throw new DeviceError(`${device} has no driver to read what is written to it: write to its endpoints`);
    const driver = this.drivers.get(name);
    if (!driver) throw new DeviceError(`${device}'s driver ${name} is not running`);
    if (!driver.input) throw new DeviceError(`${device}'s driver ${name} takes nothing written to the device`);
    const by = raw.by ?? await this.nameOf(access.uid);
    try {
      return await driver.input({ device, path, attrs: node.attrs, bytes: raw.bytes, contentType: raw.contentType, query: raw.query, by }) ?? {};
    } catch (error) {
      throw error instanceof DeviceError ? error : new DeviceError(`${device}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async command(access: Access, path: string, text: string): Promise<{ value: DeviceValue }> {
    const node = await this.sys.vfs.get<ControlAttrs>(access, path);
    if (node.type !== NODE_TYPE_CONTROL) throw new DeviceError(`${path}: not a control`);
    assertAccess(access, node, 'w');
    const devicePathOf = dirname(path);
    const deviceNode = await this.sys.vfs.get<DeviceNodeAttrs>(ADMIN_ACCESS, devicePathOf);
    if (deviceNode.type !== NODE_TYPE_DEVICE) throw new DeviceError(`${path}: not under a device`);
    const device = basename(devicePathOf);
    const endpoint = basename(path);

    const current = (await readTail<{ value?: DeviceValue }>(this.sys.vfs, ADMIN_ACCESS, path, 1))[0]?.value?.value;
    let value: DeviceValue;
    try {
      value = parseControlValue(node.attrs.schema ?? { type: 'text' }, text, current);
    } catch (error) {
      if (error instanceof ControlValueError) throw new DeviceError(`${device}/${endpoint} ${error.message}`);
      throw error;
    }

    const name = deviceNode.attrs.driver;
    const driver = name ? this.drivers.get(name) : undefined;
    if (!name) throw new DeviceError(`${device} has no driver to send ${endpoint} to`);
    if (!driver?.write) throw new DeviceError(`${device}'s driver ${name} is not running`);

    const by = await this.nameOf(access.uid);
    // The request is the control's attr, written as the writer: the audit's record of who switched what.
    await this.sys.vfs.update(access, path, { attrs: { requested: { value, at: new Date().toISOString(), by } } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        driver.write({ device, endpoint, path, attrs: deviceNode.attrs, endpointAttrs: node.attrs, value, by }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DeviceError(`${device} did not answer within ${WRITE_TIMEOUT_MS / 1000} s`)), WRITE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      throw error instanceof DeviceError ? error : new DeviceError(`${device}/${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    return { value };
  }

  // ===== What drivers write =====

  async ensureDevice(access: Access, name: string, attrs: Partial<DeviceAttrs>): Promise<string> {
    assertName('device', name);
    const path = devicePath(name);
    const existing = await this.sys.vfs.get<DeviceNodeAttrs>(access, path).catch((error) => {
      if (error instanceof NodeNotFoundError) return undefined;
      throw error;
    });
    if (existing) {
      if (existing.type !== NODE_TYPE_DEVICE) throw new DeviceError(`${path} is a ${existing.type}, not a device`);
      const { label: _label, ...rest } = attrs;
      const changed = changedAttrs(existing.attrs, rest);
      if (changed) await this.sys.vfs.update(access, path, { attrs: changed });
      return path;
    }
    const gid = await groupGid(this.sys.vfs, DEVICES_GROUPNAME);
    await this.sys.vfs.create<DeviceNodeAttrs>(access, NODE_TYPE_DEVICE, DEV_PATH, name, {
      attrs: { ...attrs, label: attrs.label || name },
      props: { mode: 0o775, ...(gid !== undefined ? { gid } : {}) },
    });
    return path;
  }

  async ensureEndpoint(access: Access, device: string, name: string, type: EndpointType, attrs: EndpointAttrs, mode?: number): Promise<string> {
    assertName('endpoint', name);
    const parent = devicePath(device);
    const path = join(parent, name);
    const existing = await this.sys.vfs.get(access, path).catch((error) => {
      if (error instanceof NodeNotFoundError) return undefined;
      throw error;
    });
    if (existing) {
      if (existing.type !== type) throw new DeviceError(`${path} is a ${existing.type}, not a ${type}: remove it first`);
      const { label: _label, ...rest } = attrs;
      const changed = changedAttrs(existing.attrs, rest);
      if (changed) await this.sys.vfs.update(access, path, { attrs: changed });
      this.endpoints.set(`${device}/${name}`, { path, type, attrs: { ...existing.attrs, ...rest } as EndpointAttrs, readAt: Date.now() });
      return path;
    }
    const control = type === NODE_TYPE_CONTROL;
    await this.sys.vfs.create(access, type, parent, name, {
      attrs: { ...attrs },
      props: { mode: mode ?? (control ? 0o664 : 0o644), ...(control ? { gid: USERS_GID } : {}) },
    });
    this.endpoints.set(`${device}/${name}`, { path, type, attrs, readAt: Date.now() });
    return path;
  }

  async removeEndpoint(access: Access, device: string, endpoint: string): Promise<void> {
    assertName('endpoint', endpoint);
    const key = `${device}/${endpoint}`;
    await this.sys.vfs.unlink(access, join(devicePath(device), endpoint), devicePath(device), { recursive: true });
    this.endpoints.delete(key);
    this.published.delete(key);
    this.dropPending(key);
  }

  async append(access: Access, device: string, endpoint: string, value: DeviceValue | DeviceFix, opts: AppendOptions = {}): Promise<boolean> {
    const ep = await this.endpointOf(access, device, endpoint);
    const at = opts.at ?? new Date();
    if (ep.type === 'track') {
      if (!isFix(value)) throw new DeviceError(`${device}/${endpoint} is a track: it takes a fix`);
      return await this.appendFixes(access, device, endpoint, [{ ...value, ts: at.toISOString() }]) > 0;
    }
    if (isFix(value)) throw new DeviceError(`${device}/${endpoint} is a ${ep.type}: a fix goes to a track`);

    const key = `${device}/${endpoint}`;
    // A button's presses are each an event, the same one twice included.
    if (ep.attrs.events) {
      await this.take(access, device, endpoint, ep, value, at, opts.retained);
      return true;
    }
    const decision = decide(await this.lastOf(key, ep), value, at.getTime(), (ep.attrs.minInterval ?? 0) * 1000);
    if (decision.publish === 'no') {
      this.dropPending(key);
      return false;
    }
    if (decision.publish === 'later') {
      this.dropPending(key);
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        if (!pending) return;
        this.take(pending.access, device, endpoint, ep, pending.value, pending.at, pending.retained).catch((error) =>
          logger.warn('a reading held back could not be appended', { device, endpoint, error: String(error) })
        );
      }, Math.max(0, decision.at - Date.now()));
      this.pending.set(key, { timer, value, at, retained: opts.retained, access });
      return false;
    }
    this.dropPending(key);
    await this.take(access, device, endpoint, ep, value, at, opts.retained);
    return true;
  }

  async appendFixes(access: Access, device: string, endpoint: string, fixes: ({ ts?: string } & DeviceFix)[]): Promise<number> {
    const ep = await this.endpointOf(access, device, endpoint);
    if (ep.type !== 'track') throw new DeviceError(`${device}/${endpoint} is a ${ep.type}, not a track`);
    if (fixes.length === 0) return 0;
    const handle = await this.sys.vfs.open(access, ep.path, { mode: 'a' });
    let taken: number;
    try {
      if (!(handle instanceof TrackHandle)) throw new DeviceError(`${ep.path}: not a track`);
      taken = await handle.appendPoints(fixes);
    } finally {
      await handle.close();
    }
    // The newest is what a live map wants; a file's thousands are not each news.
    const newest = fixes.reduce((a, b) => (a.ts ?? '') >= (b.ts ?? '') ? a : b);
    const { ts, ...fix } = newest;
    this.publish(device, endpoint, { device, endpoint, fix, at: ts ?? new Date().toISOString() });
    return taken;
  }

  async online(access: Access, device: string, up: boolean): Promise<void> {
    const path = devicePath(device);
    const node = await this.sys.vfs.get<DeviceNodeAttrs>(access, path);
    if (node.attrs.online === up) return;
    await this.sys.vfs.update(access, path, { attrs: { online: up } });
    this.publish(device, undefined, { device, online: up, at: new Date().toISOString() });
  }

  async forget(access: Access, device: string): Promise<void> {
    assertName('device', device);
    const node = await this.sys.vfs.get<DeviceNodeAttrs>(access, devicePath(device));
    const driver = node.attrs.driver ? this.drivers.get(node.attrs.driver) : undefined;
    // First, so a driver that would find it again (a broker's retained announcement) lets it go.
    await driver?.forget?.(device);
    await this.sys.vfs.unlink(access, devicePath(device), DEV_PATH, { recursive: true });
    for (const key of [...this.endpoints.keys(), ...this.published.keys(), ...this.pending.keys()]) {
      if (!key.startsWith(`${device}/`)) continue;
      this.endpoints.delete(key);
      this.published.delete(key);
      this.dropPending(key);
    }
  }

  // ===== Within =====

  private async endpointOf(access: Access, device: string, endpoint: string): Promise<Endpoint> {
    const key = `${device}/${endpoint}`;
    const known = this.endpoints.get(key);
    if (known && Date.now() - known.readAt < ENDPOINT_TTL_MS) return known;
    const path = join(devicePath(device), endpoint);
    const node = await this.sys.vfs.get(access, path);
    if (node.type !== NODE_TYPE_LOG && node.type !== 'track' && node.type !== NODE_TYPE_CONTROL) throw new DeviceError(`${path} is a ${node.type}, not an endpoint`);
    const ep: Endpoint = { path, type: node.type as EndpointType, attrs: node.attrs as EndpointAttrs, readAt: Date.now() };
    this.endpoints.set(key, ep);
    return ep;
  }

  /** The value last published for an endpoint, read from its log the first time it is asked for. */
  private async lastOf(key: string, ep: Endpoint): Promise<Published | undefined> {
    if (this.published.has(key)) return this.published.get(key);
    const last = (await readTail<{ value?: DeviceValue }>(this.sys.vfs, ADMIN_ACCESS, ep.path, 1))[0];
    if (last && last.value && 'value' in last.value) this.published.set(key, { value: last.value.value ?? null, at: last.at });
    return this.published.get(key);
  }

  private dropPending(key: string): void {
    const pending = this.pending.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  private async take(access: Access, device: string, endpoint: string, ep: Endpoint, value: DeviceValue, at: Date, retained?: boolean): Promise<void> {
    const handle = await this.sys.vfs.open(access, ep.path, { mode: 'a' });
    try {
      if (!(handle instanceof LogHandle)) throw new DeviceError(`${ep.path}: not a log`);
      await handle.appendAt({ value }, at);
    } finally {
      await handle.close();
    }
    this.published.set(`${device}/${endpoint}`, { value, at: at.getTime() });
    this.publish(device, endpoint, {
      device,
      endpoint,
      value,
      ...(ep.attrs.unit ? { unit: ep.attrs.unit } : {}),
      ...(ep.attrs.events ? { event: true as const } : {}),
      at: at.toISOString(),
      ...(retained ? { retained: true as const } : {}),
    });
  }

  private publish(device: string, endpoint: string | undefined, message: DeviceMessage): void {
    this.sys.routerManager.publish(deviceRoutingKey(device, endpoint), message);
  }

  /** An account's name for its uid, as `ls` shows it; the uid itself for one with none. */
  private async nameOf(uid: number): Promise<string> {
    const known = this.names.get(uid);
    if (known) return known;
    for (const entry of await this.sys.vfs.children(ADMIN_ACCESS, USERS_PATH)) {
      if (isUserNode(entry.node)) this.names.set(entry.node.attrs.uid, entry.name);
    }
    return this.names.get(uid) ?? String(uid);
  }
}

/**
 * Core's own driver: a phone, a GPS tracker or logger, posting or uploaded. Whatever it is written
 * — Traccar Client's JSON, OsmAnd's query, a GPRMC sentence, a GPX file, EiN's own fixes — goes to
 * the device's `position` track, made on its first fix.
 */
const trackerDriver = (devices: DeviceManager): Driver => ({
  description: 'A phone, GPS tracker or logger: its position, posted as it goes or as GPX files',
  async setup(device) {
    await devices.ensureEndpoint(ADMIN_ACCESS, device, 'position', 'track', { label: 'Position' });
  },
  async input(raw) {
    const body = new TextDecoder().decode(raw.bytes);
    const fixes = readTrackerRequest(new URL(`http://device/?${raw.query ?? ''}`), raw.contentType ?? '', body);
    if ('error' in fixes) throw new DeviceError(`${raw.device}: ${fixes.error}`);
    if (fixes.points.length === 0) return { taken: 0 };
    await devices.ensureEndpoint(ADMIN_ACCESS, raw.device, 'position', 'track', { label: 'Position' });
    const taken = await devices.appendFixes(ADMIN_ACCESS, raw.device, 'position', fixes.points);
    return { taken, message: `${taken} of ${fixes.points.length} fixes new` };
  },
});
