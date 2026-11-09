/**
 * Devices read back as the caller may see them: what `devices`, `device-show` and `device-history`
 * answer. A log's or control's value is its last entry's `value`; a track's is its summary.
 */

import { join } from '@std/path';
import type { Access } from '../../lib/access/types.ts';
import { verifyAccess } from '../../lib/access/verify-access.ts';
import type {
  DeviceAttrs,
  DeviceFix,
  DeviceHistory,
  DeviceInfo,
  DeviceSummary,
  DeviceValue,
  EndpointAttrs,
  EndpointSummary,
  EndpointType,
  HistoryAggregate,
} from '../../lib/api/devices.ts';
import { SYSTEM_TIME_ZONE } from '../../lib/datetime/timezone.ts';
import { readBuckets, readRange, readTail } from '../../lib/metrics/read.ts';
import { DEV_PATH, devicePath } from '../../lib/paths.ts';
import { TrackHandle } from '../../registries/track/track-handle.ts';
import type { Node } from '../../vfs/node.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import { NODE_TYPE_CONTROL, NODE_TYPE_DEVICE } from '../../vfs/types/device.ts';
import { NODE_TYPE_LOG } from '../../vfs/types/log.ts';
import type { DeviceManager } from './device-manager.ts';

const ENDPOINT_NODE_TYPES = new Set<string>([NODE_TYPE_LOG, 'track', NODE_TYPE_CONTROL]);

type Entry = { value?: DeviceValue };

const valueOf = (entry: unknown): DeviceValue | undefined => entry !== null && typeof entry === 'object' && 'value' in entry ? (entry as Entry).value ?? null : undefined;

/** The last `limit` values of a log or control, oldest first. */
const valuesOf = async (vfs: ModuleVFS, access: Access, path: string, limit: number): Promise<{ at: string; value: DeviceValue }[]> =>
  (await readTail<unknown>(vfs, access, path, limit)).flatMap((sample) => {
    const value = valueOf(sample.value);
    return value === undefined ? [] : [{ at: new Date(sample.at).toISOString(), value }];
  });

/** The values of a log or control written in `[since, until)`, oldest first; with `limit`, the latest that many. */
const valuesBetween = async (
  vfs: ModuleVFS,
  access: Access,
  path: string,
  range: { since?: Date; until?: Date; limit?: number },
): Promise<{ at: string; value: DeviceValue }[]> =>
  (await readRange<unknown>(vfs, access, path, range)).flatMap((sample) => {
    const value = valueOf(sample.value);
    return value === undefined ? [] : [{ at: new Date(sample.at).toISOString(), value }];
  });

/** A bucket's value as `device-history` gives it: an average to five significant digits, more than any sensor measures. */
const bucketValue = (value: DeviceValue, aggregate: HistoryAggregate): DeviceValue => aggregate === 'avg' && typeof value === 'number' ? Number(value.toPrecision(5)) : value;

/**
 * The values of a log or control in `[since, until)` summed up per interval of `seconds`, oldest
 * first; a day is a calendar day in the system's time zone, and on and off count as 1 and 0.
 */
const valuesPer = async (
  vfs: ModuleVFS,
  access: Access,
  path: string,
  query: { since?: Date; until?: Date; seconds: number; aggregate: HistoryAggregate },
): Promise<{ at: string; value: DeviceValue; count: number }[]> =>
  (await readBuckets(vfs, access, path, {
    since: query.since,
    until: query.until,
    bucketSeconds: query.seconds,
    aggregate: query.aggregate,
    field: ['value'],
    timeZone: SYSTEM_TIME_ZONE,
  })).map((bucket) => ({ at: new Date(bucket.at).toISOString(), value: bucketValue(bucket.value as DeviceValue, query.aggregate), count: bucket.count }));

/** A track's fixes in `[since, until)`, oldest first; with `limit`, the latest that many. */
const fixesBetween = async (
  vfs: ModuleVFS,
  access: Access,
  path: string,
  range: { since?: Date; until?: Date; limit?: number },
): Promise<({ at: string } & DeviceFix)[]> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    if (!(handle instanceof TrackHandle)) throw new Error(`${path}: not a track`);
    const read = await handle.readPoints({ from: range.since?.toISOString(), to: range.until?.toISOString() });
    const points = read.segments.flatMap((segment) => segment.points);
    const kept = range.limit !== undefined ? points.slice(Math.max(0, points.length - range.limit)) : points;
    return kept.map(({ ts, lat, lng, alt, speed, course }) => ({
      at: ts,
      lat,
      lng,
      ...(alt !== undefined ? { alt } : {}),
      ...(speed !== undefined ? { speed } : {}),
      ...(course !== undefined ? { course } : {}),
    }));
  } finally {
    await handle.close();
  }
};

type EndpointNode = { name: string; node: Node };

/** A device's endpoints, in name order. */
const endpointsOf = async (vfs: ModuleVFS, access: Access, device: string): Promise<EndpointNode[]> =>
  (await vfs.children(access, devicePath(device)))
    .filter((child) => ENDPOINT_NODE_TYPES.has(child.node.type) && !child.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

/** What a card would rather show, first to last. */
const MAIN_CLASSES = ['temperature', 'power', 'humidity', 'illuminance', 'energy'];

/**
 * The endpoint a card shows: a reading of the first of `MAIN_CLASSES` the device has, else its first
 * reading, else its first control; never an event log, nor one about the device itself (`category`).
 */
const mainOf = (endpoints: EndpointNode[]): EndpointNode | undefined => {
  const attrsOf = (ep: EndpointNode) => ep.node.attrs as EndpointAttrs;
  const live = endpoints.filter((ep) => !attrsOf(ep).retired && attrsOf(ep).supported !== false && !attrsOf(ep).category && !attrsOf(ep).events);
  const readings = live.filter((ep) => ep.node.type === NODE_TYPE_LOG);
  for (const deviceClass of MAIN_CLASSES) {
    const found = readings.find((ep) => attrsOf(ep).deviceClass === deviceClass);
    if (found) return found;
  }
  return readings[0] ?? live.find((ep) => ep.node.type === NODE_TYPE_CONTROL);
};

const summaryOf = (device: string, attrs: DeviceAttrs, endpoints: EndpointNode[]): DeviceSummary => ({
  name: device,
  path: devicePath(device),
  label: attrs.label ?? device,
  ...(attrs.class ? { class: attrs.class } : {}),
  ...(attrs.driver ? { driver: attrs.driver } : {}),
  ...(attrs.manufacturer ? { manufacturer: attrs.manufacturer } : {}),
  ...(attrs.model ? { model: attrs.model } : {}),
  ...(typeof attrs.online === 'boolean' ? { online: attrs.online } : {}),
  endpoints: endpoints.length,
  tracks: endpoints.some((ep) => ep.node.type === 'track'),
});

/** The main value of a device, and when its latest value came, added to its summary. */
const withMain = async (vfs: ModuleVFS, access: Access, device: string, summary: DeviceSummary, endpoints: EndpointNode[]): Promise<DeviceSummary> => {
  const main = mainOf(endpoints);
  const last = main ? (await valuesOf(vfs, access, join(devicePath(device), main.name), 1))[0] : undefined;
  if (main && last) {
    const attrs = main.node.attrs as EndpointAttrs;
    summary.main = { endpoint: main.name, label: attrs.label ?? main.name, value: last.value, ...(attrs.unit ? { unit: attrs.unit } : {}) };
    summary.lastAt = last.at;
  }
  return summary;
};

/** Every device the caller may read, by label: the devices group's members see them all, anyone else those shared with them. */
export const listDevices = async (vfs: ModuleVFS, access: Access): Promise<DeviceSummary[]> => {
  const children = (await vfs.children<DeviceAttrs>(access, DEV_PATH)).filter((child) => child.node.type === NODE_TYPE_DEVICE);
  const summaries = await Promise.all(children.map(async (child) => {
    const endpoints = await endpointsOf(vfs, access, child.name).catch(() => []);
    return await withMain(vfs, access, child.name, summaryOf(child.name, child.node.attrs, endpoints), endpoints);
  }));
  return summaries.sort((a, b) => a.label.localeCompare(b.label));
};

const endpointSummary = async (vfs: ModuleVFS, access: Access, device: string, ep: EndpointNode): Promise<EndpointSummary> => {
  const attrs = ep.node.attrs as EndpointAttrs;
  const path = join(devicePath(device), ep.name);
  const type = ep.node.type as EndpointType;
  const summary: EndpointSummary = {
    name: ep.name,
    path,
    type,
    label: attrs.label ?? ep.name,
    ...(attrs.unit ? { unit: attrs.unit } : {}),
    ...(attrs.deviceClass ? { deviceClass: attrs.deviceClass } : {}),
    ...(attrs.category ? { category: attrs.category } : {}),
    ...(attrs.events ? { events: true } : {}),
    ...(attrs.schema ? { schema: attrs.schema } : {}),
    ...(attrs.requested ? { requested: attrs.requested } : {}),
    supported: attrs.supported !== false,
    retired: attrs.retired === true,
    writable: verifyAccess(access, ep.node.props, 'w'),
  };
  if (type === 'track') {
    const track = (await vfs.trackSummaries(access, [ep.node.id])).get(ep.node.id);
    summary.track = { points: track?.points ?? 0, ...(track?.firstTs ? { firstAt: track.firstTs } : {}), ...(track?.lastTs ? { lastAt: track.lastTs } : {}) };
  } else {
    const last = (await valuesOf(vfs, access, path, 1))[0];
    if (last) summary.last = last;
  }
  return summary;
};

/** A device and its endpoints with their latest values, and whether its driver runs. */
export const deviceInfo = async (vfs: ModuleVFS, access: Access, devices: DeviceManager | undefined, device: string): Promise<DeviceInfo> => {
  const node = await vfs.get<DeviceAttrs>(access, devicePath(device));
  if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${device} is not a device`);
  const endpoints = await endpointsOf(vfs, access, device);
  const endpointList = await Promise.all(endpoints.map((ep) => endpointSummary(vfs, access, device, ep)));
  const summary = await withMain(vfs, access, device, summaryOf(device, node.attrs, endpoints), endpoints);
  const latest = endpointList.map((ep) => ep.last?.at ?? ep.track?.lastAt).filter((at): at is string => Boolean(at)).sort().at(-1);
  const driver = node.attrs.driver ? devices?.driver(node.attrs.driver) : undefined;
  return {
    ...summary,
    ...(latest ? { lastAt: latest } : {}),
    ...(node.attrs.firmware ? { firmware: node.attrs.firmware } : {}),
    ...(node.attrs.serial ? { serial: node.attrs.serial } : {}),
    ...(node.attrs.mac ? { mac: node.attrs.mac } : {}),
    ...(node.attrs.url && /^https?:\/\//.test(node.attrs.url) ? { url: node.attrs.url } : {}),
    ...(node.attrs.config ? { config: node.attrs.config } : {}),
    ...(node.attrs.driver ? { driverRunning: driver !== undefined } : {}),
    input: driver?.input !== undefined,
    endpointList,
  };
};

/**
 * A device's endpoint's history: a log's or control's values (summed up per interval with
 * `bucket`), a track's fixes.
 */
export const deviceHistory = async (
  vfs: ModuleVFS,
  access: Access,
  device: string,
  endpoint: string,
  query: { since?: Date; until?: Date; limit: number; bucket?: { seconds: number; aggregate: HistoryAggregate } },
): Promise<DeviceHistory> => {
  const path = join(devicePath(device), endpoint);
  const node = await vfs.get(access, path);
  if (!ENDPOINT_NODE_TYPES.has(node.type)) throw new Error(`${device}/${endpoint} is a ${node.type}, not an endpoint`);
  const type = node.type as EndpointType;
  const attrs = node.attrs as EndpointAttrs;
  const base = { device, endpoint, type, ...(attrs.unit ? { unit: attrs.unit } : {}) };
  if (type === 'track') {
    return { ...base, readings: [], fixes: await fixesBetween(vfs, access, path, { since: query.since, until: query.until, limit: query.limit }) };
  }
  if (query.bucket) {
    const rows = await valuesPer(vfs, access, path, { since: query.since, until: query.until, seconds: query.bucket.seconds, aggregate: query.bucket.aggregate });
    return { ...base, bucket: query.bucket, readings: rows.slice(Math.max(0, rows.length - query.limit)) };
  }
  const readings = query.since || query.until
    ? await valuesBetween(vfs, access, path, { since: query.since, until: query.until, limit: query.limit })
    : await valuesOf(vfs, access, path, query.limit);
  return { ...base, readings };
};
