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
