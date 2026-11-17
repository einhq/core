/**
 * The machine's disk activity, network traffic and fans, as the kernel reports them.
 *
 * Disk activity is `/proc/diskstats`, the machine's in a container too. Network traffic is
 * `/proc/net/dev`, which is the network namespace's: in a container with a network of its own that
 * is the container's traffic, not the machine's. So only disks and interfaces on hardware are read,
 * those with a `device` link in sysfs; a container's namespace has no such interface, and its
 * network is left out rather than passed off as the machine's.
 *
 * Disks and interfaces give cumulative counters; a rate is between two samples (`activityRates`).
 */

/** One disk's counters since boot: bytes read and written, and milliseconds it had I/O in flight. */
type DiskCounters = { name: string; readBytes: number; writtenBytes: number; busyMs: number };

/** One network interface's counters since it came up: bytes received and sent. */
type InterfaceCounters = { name: string; receivedBytes: number; sentBytes: number };

/** The counters of one moment. */
export type ActivityCounters = { at: number; disks: DiskCounters[]; interfaces: InterfaceCounters[] };

/** One disk's activity between two samples: bytes per second read and written, and % of the time busy. */
export type DiskRate = { name: string; readBytesPerSecond: number; writtenBytesPerSecond: number; busyPercent: number };

/** One interface's traffic between two samples, in bytes per second. */
export type InterfaceRate = { name: string; receivedBytesPerSecond: number; sentBytesPerSecond: number };

/** One fan: its label where the chip gives one, else the chip and its number (`nct6798 fan2`), and its speed. */
export type FanSample = { fan: string; rpm: number };

/** `/proc/diskstats` counts in sectors of 512 bytes, whatever the disk's own sector size. */
const SECTOR_BYTES = 512;

/**
 * The lines of `/proc/diskstats` for the disks `wanted` keeps: major, minor, name, then reads
 * completed, merged, sectors read, ms reading, writes completed, merged, sectors written, ms
 * writing, I/Os in flight, ms doing I/O.
 */
export const parseDiskstats = (text: string, wanted: (name: string) => boolean): DiskCounters[] => {
  const disks: DiskCounters[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14 || !wanted(fields[2])) continue;
    const [sectorsRead, sectorsWritten, busyMs] = [fields[5], fields[9], fields[12]].map(Number);
    if (![sectorsRead, sectorsWritten, busyMs].every(Number.isFinite)) continue;
    disks.push({ name: fields[2], readBytes: sectorsRead * SECTOR_BYTES, writtenBytes: sectorsWritten * SECTOR_BYTES, busyMs });
  }
  return disks;
};

/** The interfaces of `/proc/net/dev` that `wanted` keeps: `name: rx-bytes … (8 fields) tx-bytes …`. */
export const parseNetDev = (text: string, wanted: (name: string) => boolean): InterfaceCounters[] => {
  const interfaces: InterfaceCounters[] = [];
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!wanted(name) || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    interfaces.push({ name, receivedBytes: fields[0], sentBytes: fields[8] });
  }
  return interfaces;
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
};

/** The entries of a sysfs class folder that are hardware: those with a `device` link. */
const onHardware = async (folder: string): Promise<Set<string>> => {
  const names = new Set<string>();
  try {
    for await (const entry of Deno.readDir(folder)) {
      try {
        await Deno.stat(`${folder}/${entry.name}/device`);
        names.add(entry.name);
      } catch {
        // Virtual: a loop device, a bridge, a container's own interface.
      }
    }
  } catch {
    // No sysfs.
  }
  return names;
};

/** The counters of the machine's disks and of its interfaces on hardware; none where they do not read. */
export const sampleActivity = async (): Promise<ActivityCounters> => {
  const [diskstats, netDev, disks, interfaces] = await Promise.all([
    readText('/proc/diskstats'),
    readText('/proc/net/dev'),
    onHardware('/sys/block'),
    onHardware('/sys/class/net'),
  ]);
  return {
    at: Date.now(),
    disks: diskstats ? parseDiskstats(diskstats, (name) => disks.has(name)) : [],
    interfaces: netDev ? parseNetDev(netDev, (name) => interfaces.has(name)) : [],
  };
};

/**
 * The rates between two samples, for each disk and interface in both. One whose counters went down
 * (a reboot, an interface brought down and up) has no rate this time.
 */
export const activityRates = (before: ActivityCounters, after: ActivityCounters): { disks: DiskRate[]; interfaces: InterfaceRate[] } => {
  const ms = after.at - before.at;
  if (ms <= 0) return { disks: [], interfaces: [] };
  const perSecond = (from: number, to: number) => (to - from) / ms * 1000;

  const disksBefore = new Map(before.disks.map((disk) => [disk.name, disk]));
  const disks: DiskRate[] = [];
  for (const disk of after.disks) {
    const was = disksBefore.get(disk.name);
    if (!was || disk.readBytes < was.readBytes || disk.writtenBytes < was.writtenBytes || disk.busyMs < was.busyMs) continue;
    disks.push({
      name: disk.name,
      readBytesPerSecond: perSecond(was.readBytes, disk.readBytes),
      writtenBytesPerSecond: perSecond(was.writtenBytes, disk.writtenBytes),
      busyPercent: Math.min(100, (disk.busyMs - was.busyMs) / ms * 100),
    });
  }

  const interfacesBefore = new Map(before.interfaces.map((iface) => [iface.name, iface]));
  const interfaces: InterfaceRate[] = [];
  for (const iface of after.interfaces) {
    const was = interfacesBefore.get(iface.name);
    if (!was || iface.receivedBytes < was.receivedBytes || iface.sentBytes < was.sentBytes) continue;
    interfaces.push({
      name: iface.name,
      receivedBytesPerSecond: perSecond(was.receivedBytes, iface.receivedBytes),
      sentBytesPerSecond: perSecond(was.sentBytes, iface.sentBytes),
    });
  }
  return { disks, interfaces };
};

const HWMON = '/sys/class/hwmon';

/**
 * Every fan the kernel's hardware monitors read, `fan<n>_input` in rpm: named by its label where the
 * chip gives one, else by the chip and its number. None where there is no fan sensor.
 */
export const sampleFans = async (): Promise<FanSample[]> => {
  const chips: string[] = [];
  try {
    for await (const entry of Deno.readDir(HWMON)) chips.push(entry.name);
  } catch {
    return [];
  }
  chips.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const fans: FanSample[] = [];
  for (const chip of chips) {
    const inputs: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${HWMON}/${chip}`)) {
        if (/^fan\d+_input$/.test(entry.name)) inputs.push(entry.name.slice(0, -'_input'.length));
      }
    } catch {
      continue;
    }
    if (inputs.length === 0) continue;
    inputs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const chipName = (await readText(`${HWMON}/${chip}/name`))?.trim() || chip;
    for (const fan of inputs) {
      const [input, label] = await Promise.all([readText(`${HWMON}/${chip}/${fan}_input`), readText(`${HWMON}/${chip}/${fan}_label`)]);
      const rpm = Number(input?.trim());
      if (input === undefined || !Number.isFinite(rpm)) continue;
      fans.push({ fan: label?.trim() || `${chipName} ${fan}`, rpm });
    }
  }
  return fans;
};
