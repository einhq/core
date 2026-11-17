/**
 * The machine as a device: its name from the hostname, the endpoints its readings make, and on a
 * booted EiN the device the sampler writes, which only the administrators see.
 */

import { assertEquals } from '@std/assert';
import type { DeviceHistory, DeviceInfo, DeviceSummary } from '../../../lib/api/devices.ts';
import { ADMIN_ACCESS, ADMIN_GID } from '../../../lib/access/constants.ts';
import { SystemTestHarness, testCommands } from '../../../testing/mod.ts';
import { HostDevice, hostDeviceName, hostReadings } from '../host.ts';
import { parseDf, volumesOf } from '../../../lib/metrics/disk.ts';
import { activityRates, parseDiskstats, parseNetDev } from '../../../lib/metrics/activity.ts';

Deno.test('hostDeviceName: the first label of the hostname, as a device name', () => {
  assertEquals(hostDeviceName('fry.local'), 'fry');
  assertEquals(hostDeviceName('Old_Box'), 'old_box');
  assertEquals(hostDeviceName('My Laptop'), 'my-laptop');
  assertEquals(hostDeviceName(''), 'host');
  assertEquals(hostDeviceName('---'), 'host');
  assertEquals(hostDeviceName('null'), 'host', "core's own name in /dev is not taken");
});

Deno.test('hostReadings: each reading an endpoint, named and rounded as a polled host has them', () => {
  const readings = hostReadings({
    cpu: 12.345,
    load: 1.23456,
    memory: { totalBytes: 32e9, availableBytes: 8e9 },
    memoryTotalBytes: 32 * 2 ** 30,
    temperatures: [{ zone: 'x86_pkg_temp', celsius: 41.04 }, { zone: 'acpitz', celsius: 27.8 }, { zone: 'acpitz', celsius: 30 }],
    volumes: [{ name: 'sdc1', totalBytes: 2000, freeBytes: 1500 }, { name: 'empty', totalBytes: 0, freeBytes: 0 }],
    uptimeSeconds: 2.5 * 86_400,
  });
  assertEquals(readings.map((reading) => [reading.endpoint, reading.value]), [
    ['cpu', 12.3],
    ['load', 1.23],
    ['memory-used', 75],
    ['x86_pkg_temp-temperature', 41],
    ['acpitz-temperature', 27.8],
    ['acpitz-2-temperature', 30],
    ['sdc1-used', 25],
    ['memory-total', 32],
    ['uptime', 2.5],
  ]);
  const attrs = Object.fromEntries(readings.map((reading) => [reading.endpoint, reading.attrs]));
  assertEquals([attrs.cpu.category, attrs.cpu.retention], [undefined, '30 day']);
  assertEquals([attrs['acpitz-temperature'].category, attrs['acpitz-temperature'].deviceClass], ['diagnostic', 'temperature']);
  assertEquals([attrs['sdc1-used'].unit, attrs['sdc1-used'].retention], ['%', '365 day']);
  assertEquals(hostReadings({}), []);
});

Deno.test('hostReadings: disk activity, network traffic and fans', () => {
  const readings = hostReadings({
    disks: [{ name: 'sdc', readBytesPerSecond: 1_234_567, writtenBytesPerSecond: 0, busyPercent: 12.34 }],
    interfaces: [{ name: 'enp2s0', receivedBytesPerSecond: 125_000, sentBytesPerSecond: 1_250 }],
    fans: [{ fan: 'nct6798 fan2', rpm: 812.4 }, { fan: 'CPU Fan', rpm: 1500 }, { fan: 'CPU Fan', rpm: 0 }],
  });
  assertEquals(readings.map((reading) => [reading.endpoint, reading.value, reading.attrs.unit]), [
    ['nct6798-fan2-speed', 812, 'rpm'],
    ['cpu-fan-speed', 1500, 'rpm'],
    ['cpu-fan-2-speed', 0, 'rpm'],
    ['sdc-read', 1.23, 'MB/s'],
    ['sdc-written', 0, 'MB/s'],
    ['sdc-busy', 12.3, '%'],
    ['enp2s0-received', 1, 'Mbit/s'],
    ['enp2s0-sent', 0.01, 'Mbit/s'],
  ]);
  assertEquals(readings.every((reading) => reading.attrs.category === 'diagnostic' && reading.attrs.retention === '30 day'), true, 'the card keeps showing the CPU');
});

Deno.test('parseDiskstats and parseNetDev: the counters of the disks and interfaces asked for', () => {
  const diskstats = [
    '   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
    '   8       0 sda 25561360 10767193 992224379 22669231 22421411 20951319 634163682 52957894 0 15928018 84110020 0 0 0 0 8021267 8482893',
    '   8       2 sda2 25560968 10766166 992203314 22669064 22421409 20951319 634163680 52957890 0 17989186 75626955 0 0 0 0 0 0',
  ].join('\n');
  assertEquals(parseDiskstats(diskstats, (name) => name === 'sda'), [{ name: 'sda', readBytes: 992224379 * 512, writtenBytes: 634163682 * 512, busyMs: 15928018 }]);

  const netDev = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
    'enp2s0: 19761429364 12338001    0    0    0     0          0         0 7446277893 8314536    0    0    0     0       0          0',
  ].join('\n');
  assertEquals(parseNetDev(netDev, (name) => name !== 'lo'), [{ name: 'enp2s0', receivedBytes: 19761429364, sentBytes: 7446277893 }]);
});

Deno.test('activityRates: per second between two samples; a counter that went down gives none', () => {
  const before = {
    at: 0,
    disks: [{ name: 'sda', readBytes: 1000, writtenBytes: 0, busyMs: 0 }, { name: 'sdb', readBytes: 5000, writtenBytes: 0, busyMs: 0 }],
    interfaces: [{ name: 'eth0', receivedBytes: 0, sentBytes: 100 }],
  };
  const after = {
    at: 60_000,
    disks: [{ name: 'sda', readBytes: 61_000, writtenBytes: 120, busyMs: 90_000 }, { name: 'sdb', readBytes: 10, writtenBytes: 0, busyMs: 0 }],
    interfaces: [{ name: 'eth0', receivedBytes: 600, sentBytes: 160 }, { name: 'eth1', receivedBytes: 9, sentBytes: 9 }],
  };
  assertEquals(activityRates(before, after), {
    disks: [{ name: 'sda', readBytesPerSecond: 1000, writtenBytesPerSecond: 2, busyPercent: 100 }],
    interfaces: [{ name: 'eth0', receivedBytesPerSecond: 10, sentBytesPerSecond: 1 }],
  });
  assertEquals(activityRates(after, after), { disks: [], interfaces: [] }, 'no time between them');
});

Deno.test("volumesOf: the machine's disks once each, block devices only", () => {
  const lines = parseDf(
    [
      'Filesystem     1024-blocks       Used  Available Capacity Mounted on',
      '/dev/sdb       7751273220 3799841264 3560714244      52% /old',
      '/dev/sdc1      1921724608  601411108 1222621444      33% /files',
      'tmpfs             3278168       1144    3277024       1% /etc/hosts',
      'overlay        1921724608  601411108 1222621444      33% /',
      '/dev/sdc1      1921724608  601411108 1222621444      33% /files-volatile',
      '/dev/mapper/vg-root  1000  400  600  40% /mnt/a b',
    ].join('\n'),
  );
  assertEquals(lines[5].mount, '/mnt/a b');
  assertEquals(volumesOf(lines), [
    { name: 'sdb', totalBytes: 7751273220 * 1024, freeBytes: 3560714244 * 1024 },
    { name: 'sdc1', totalBytes: 1921724608 * 1024, freeBytes: 1222621444 * 1024 },
    { name: 'vg-root', totalBytes: 1000 * 1024, freeBytes: 600 * 1024 },
  ]);
});

const harness = new SystemTestHarness({ boot: true, ssh: false });

Deno.test({ name: 'the host device', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs, devices } = await harness.start();
  const admin = await harness.createShellClient();
  const clients = [admin];
  const host = new HostDevice({ vfs, devices }, { name: 'testbox', label: 'testbox' });

  try {
    await t.step("the sampler's readings make the device and its endpoints, in the administrators' group", async () => {
      await host.write({ cpu: 20, memory: { totalBytes: 16e9, availableBytes: 4e9 }, volumes: [{ name: 'sda1', totalBytes: 100, freeBytes: 40 }] });
      const info = await admin.execJson<DeviceInfo>('device-show testbox');
      assertEquals([info.class, info.driver, info.driverRunning, info.main?.endpoint, info.main?.value], ['host', 'host', true, 'cpu', 20]);
      assertEquals(info.endpointList.map((ep) => [ep.name, ep.last?.value]), [['cpu', 20], ['memory-used', 75], ['sda1-used', 60]]);

      const node = await vfs.get(ADMIN_ACCESS, '/dev/testbox');
      const endpoint = await vfs.get(ADMIN_ACCESS, '/dev/testbox/cpu');
      assertEquals([node.props.gid, endpoint.props.gid, endpoint.attrs.retention], [ADMIN_GID, ADMIN_GID, '30 day']);
    });

    await t.step('devices --class lists it among the machines, not among the phones', async () => {
      const names = async (line: string) => (await admin.execJson<DeviceSummary[]>(line)).map((device) => device.name);
      assertEquals((await names('devices --class host,storage')).includes('testbox'), true);
      assertEquals((await names('devices --class phone')).includes('testbox'), false);
    });

    await t.step('a member of the devices group does not see it', async () => {
      await admin.execString('user-create anna && user-passwd anna --new-password hunter2 && group-add-member devices anna');
      const anna = await harness.createShellClient({ username: 'anna', password: 'hunter2' });
      clients.push(anna);
      const listed = await anna.execJson<DeviceSummary[]>('devices');
      assertEquals(listed.some((device) => device.name === 'testbox'), false);
      await testCommands(anna).shouldFail('device-history testbox/cpu');
    });

    await t.step('a reading that changes is kept, one that repeats is not', async () => {
      await host.write({ cpu: 20 });
      await host.write({ cpu: 35 });
      const history = await admin.execJson<DeviceHistory>('device-history testbox/cpu');
      assertEquals(history.readings.map((reading) => reading.value), [20, 35]);
    });

    await t.step('a device forgotten is made again on the next write', async () => {
      await admin.execString('device-forget testbox');
      await host.write({ cpu: 50 }).catch(() => {});
      await host.write({ cpu: 51 });
      const info = await admin.execJson<DeviceInfo>('device-show testbox');
      assertEquals(info.endpointList.map((ep) => [ep.name, ep.last?.value]), [['cpu', 51]]);
    });
  } finally {
    for (const client of clients) await client.close();
    await harness.stop();
  }
});
