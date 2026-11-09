/**
 * The machine EiN runs on, as a device: `/dev/<hostname>`, of class `host`, written by
 * `metrics-sampler` through core's `host` driver. Its readings are the machine's, not EiN's: all
 * its CPU and memory, its disks, its temperatures. Named like the readings of a host a module polls
 * (`load`, `memory-used`, `<volume>-used`, `<x>-temperature`), so every host reads alike.
 *
 * Only the administrators see it: it is in their group, not the devices group.
 */

import { ADMIN_ACCESS, ADMIN_GID } from '../../lib/access/constants.ts';
import type { DeviceValue, EndpointAttrs } from '../../lib/api/devices.ts';
import { DEV_RESERVED_NAMES } from '../../lib/paths.ts';
import type { Driver, ModuleDevices } from './types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';

export const HOST_DRIVER = 'host';

export const hostDriver: Driver = {
  description: 'The machine EiN runs on: its CPU, memory, disks and temperatures, from metrics-sampler',
};

/** The device name a hostname gives: its first label as a device name, `host` when none is left. */
export const hostDeviceName = (hostname: string): string => {
  const name = deviceName(hostname.split('.')[0]);
  return name && !DEV_RESERVED_NAMES.includes(name) ? name : 'host';
};

/** This machine's device name. */
export const thisHost = (): { name: string; label: string } => {
  let hostname = '';
  try {
    hostname = Deno.hostname();
  } catch {
    // --allow-sys not granted.
  }
  return { name: hostDeviceName(hostname), label: hostname.split('.')[0] || 'host' };
};

/** `x86_pkg_temp`, `Pch Cannonlake`, `vg-root` as an endpoint's or device's name: lower-case letters, digits, - and _, from a letter or digit. */
const deviceName = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 63);

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

const FAST = '30 day';
const SLOW = '365 day';

/** What the sampler read of the machine; any of it absent where the machine does not tell. */
type HostReadings = {
  cpu?: number;
  load?: number;
  memory?: { totalBytes: number; availableBytes: number };
  memoryTotalBytes?: number;
  temperatures?: { zone: string; celsius: number }[];
  volumes?: { name: string; totalBytes: number; freeBytes: number }[];
  uptimeSeconds?: number;
};

type Reading = { endpoint: string; attrs: EndpointAttrs; value: DeviceValue };

/** The endpoints `readings` give, each with its attrs and value. */
export const hostReadings = (readings: HostReadings): Reading[] => {
  const out: Reading[] = [];
  if (readings.cpu !== undefined) out.push({ endpoint: 'cpu', attrs: { label: 'CPU', unit: '%', retention: FAST }, value: round(readings.cpu) });
  if (readings.load !== undefined) out.push({ endpoint: 'load', attrs: { label: 'load', category: 'diagnostic', retention: FAST }, value: round(readings.load, 2) });
  if (readings.memory && readings.memory.totalBytes > 0) {
    const { totalBytes, availableBytes } = readings.memory;
    out.push({ endpoint: 'memory-used', attrs: { label: 'memory used', unit: '%', retention: FAST }, value: round((totalBytes - availableBytes) / totalBytes * 100) });
  }
  const zones = new Set<string>();
  for (const { zone, celsius } of readings.temperatures ?? []) {
    const name = deviceName(zone) || 'sensor';
    // Two zones of one type (`acpitz` twice) are told apart by their order.
    let endpoint = `${name}-temperature`;
    for (let n = 2; zones.has(endpoint); n++) endpoint = `${name}-${n}-temperature`;
    zones.add(endpoint);
    out.push({ endpoint, attrs: { label: `${zone} temperature`, unit: '°C', deviceClass: 'temperature', category: 'diagnostic', retention: FAST }, value: round(celsius) });
  }
  for (const volume of readings.volumes ?? []) {
    const name = deviceName(volume.name);
    if (!name || volume.totalBytes <= 0) continue;
    out.push({
      endpoint: `${name}-used`,
      attrs: { label: `${volume.name} used`, unit: '%', retention: SLOW },
      value: round((volume.totalBytes - volume.freeBytes) / volume.totalBytes * 100),
    });
  }
  if (readings.memoryTotalBytes) {
    out.push({ endpoint: 'memory-total', attrs: { label: 'memory', unit: 'GB', category: 'diagnostic', retention: SLOW }, value: round(readings.memoryTotalBytes / 2 ** 30) });
  }
  if (readings.uptimeSeconds !== undefined) {
    out.push({ endpoint: 'uptime', attrs: { label: 'uptime', unit: 'd', category: 'diagnostic', retention: SLOW }, value: round(readings.uptimeSeconds / 86_400) });
  }
  return out;
};

/**
 * Writes this machine's readings to its device, making the device and each endpoint the first time
 * it has one. What it made is remembered until a write fails, so a device forgotten meanwhile is
 * made again on the next.
 */
export class HostDevice {
  private deviceMade = false;
  private readonly made = new Set<string>();
  readonly name: string;
  private readonly label: string;

  constructor(private readonly sys: { vfs: NodeVFS; devices: ModuleDevices }, host = thisHost()) {
    this.name = host.name;
    this.label = host.label;
  }

  async write(readings: HostReadings): Promise<void> {
    try {
      if (!this.deviceMade) await this.ensureDevice();
      for (const reading of hostReadings(readings)) {
        if (!this.made.has(reading.endpoint)) {
          await this.sys.devices.ensureEndpoint(ADMIN_ACCESS, this.name, reading.endpoint, 'log', reading.attrs);
          this.made.add(reading.endpoint);
        }
        await this.sys.devices.append(ADMIN_ACCESS, this.name, reading.endpoint, reading.value);
      }
    } catch (error) {
      this.deviceMade = false;
      this.made.clear();
      throw error;
    }
  }

  /** The device, in the administrators' group: its endpoints are made in its group, so they are too. */
  private async ensureDevice(): Promise<void> {
    const path = await this.sys.devices.ensureDevice(ADMIN_ACCESS, this.name, { label: this.label, class: 'host', driver: HOST_DRIVER });
    const node = await this.sys.vfs.get(ADMIN_ACCESS, path);
    if (node.props.gid !== ADMIN_GID) await this.sys.vfs.update(ADMIN_ACCESS, path, { props: { gid: ADMIN_GID } });
    this.deviceMade = true;
  }
}
