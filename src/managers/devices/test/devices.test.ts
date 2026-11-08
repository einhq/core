/**
 * Devices on a booted EiN: the devices group's /dev, a tracker device a phone posts to with its key
 * and a GPX file is written to, a driver's readings kept and published, a control written through
 * its driver as whoever wrote it, values over HTTP, and forgetting a device.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import type { DeviceCreated, DeviceHistory, DeviceInfo, DeviceKeyAnswer, DeviceSummary } from '../../../lib/api/devices.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../testing/mod.ts';
import type { DriverWrite } from '../types.ts';

const harness = new SystemTestHarness({ boot: true, ssh: false });

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="eTrex 30">
  <trk><name>A walk</name><trkseg>
    <trkpt lat="57.70" lon="11.97"><time>2024-06-01T10:00:00Z</time></trkpt>
    <trkpt lat="57.71" lon="11.98"><time>2024-06-01T10:05:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

Deno.test({ name: 'devices', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices } = await harness.start();
  const admin = await harness.createShellClient();
  const clients: ShellClient[] = [admin];
  const signIn = async (username: string) => {
    const client = await harness.createShellClient({ username, password: 'hunter2' });
    clients.push(client);
    return client;
  };

  try {
    await admin.execString('user-create anna && user-passwd anna --new-password hunter2 && user-create bo && user-passwd bo --new-password hunter2');
    await admin.execString('group-add-member devices anna');
    const anna = await signIn('anna');
    const bo = await signIn('bo');

    await t.step("/dev is the devices group's to add to, and only its members make devices", async () => {
      const dev = await admin.execJson<{ props: { gid: number; mode: number } }>('stat /dev');
      const group = await admin.execJson<{ gid: number }>('group-info devices');
      assertEquals([dev.props.gid, dev.props.mode & 0o7777], [group.gid, 0o1775]);
      await testCommands(bo).shouldFailWith("device-create 'Bo phone' --driver tracker", 'devices');
      await testCommands(anna).shouldFailWith('device-create null', "core's own");
    });

    await t.step("a phone posts its position with its device's key, and nothing else does", async () => {
      const created = await anna.execJson<DeviceCreated>("device-create 'Ruby phone' --driver tracker --class phone");
      assertEquals(created, { device: 'ruby-phone', path: '/dev/ruby-phone' });
      const key = await anna.execJson<DeviceKeyAnswer>('device-key ruby-phone --new --origin https://ein.example');
      assertEquals([key.enabled, key.url?.startsWith('https://ein.example/file/dev/ruby-phone?key='), key.qrText?.endsWith('&id=ruby-phone'), key.qrSvg?.startsWith('<svg')], [
        true,
        true,
        true,
        true,
      ]);
      const secret = new URL(key.url!).searchParams.get('key')!;

      const osmand = await fetch(`${baseUrl}/file/dev/ruby-phone?key=${secret}&lat=57.7&lon=11.9&timestamp=1717236000`);
      assertEquals([osmand.status, (await osmand.json()).taken], [200, 1]);
      const traccar = await fetch(`${baseUrl}/file/dev/ruby-phone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { coords: { latitude: 57.71, longitude: 11.91 }, timestamp: '2024-06-01T10:10:00Z' } }),
      });
      assertEquals([traccar.status, (await traccar.json()).taken], [200, 1]);

      const info = await anna.execJson<DeviceInfo>('device-show ruby-phone');
      assertEquals(info.endpointList.map((ep) => [ep.name, ep.type, ep.track?.points]), [['position', 'track', 2]]);
      assertEquals([info.driver, info.driverRunning, info.input, info.tracks], ['tracker', true, true, true]);

      const wrong = await fetch(`${baseUrl}/file/dev/ruby-phone?key=not-the-key&lat=1&lon=1`);
      await wrong.body?.cancel();
      await anna.execString("device-create 'Old logger' --driver tracker");
      const elsewhere = await fetch(`${baseUrl}/file/dev/old-logger?key=${secret}&lat=1&lon=1`);
      await elsewhere.body?.cancel();
      assertEquals([wrong.status, elsewhere.status], [403, 403]);
    });

    await t.step('a GPX file written to a tracker device fills its track; a device with no driver refuses one', async () => {
      await admin.execString(`echo '${GPX}' > /tmp/walk.gpx`);
      await anna.execString('cat /tmp/walk.gpx > /dev/old-logger');
      const history = await anna.execJson<DeviceHistory>('device-history old-logger/position');
      assertEquals(history.fixes?.map((fix) => [fix.at, fix.lat]), [['2024-06-01T10:00:00.000Z', 57.7], ['2024-06-01T10:05:00.000Z', 57.71]]);
      await anna.execString('device-create Thermometer');
      await testCommands(anna).shouldFailWith('echo 21 > /dev/thermometer', 'no driver');
    });

    const writes: DriverWrite[] = [];
    let unregister = devices.registerDriver('stub', {
      description: 'a lamp for the test',
      async write(command: DriverWrite) {
        writes.push(command);
      },
    });

    await t.step("a driver's readings are kept on its endpoints and published on their keys", async () => {
      await devices.ensureDevice(ADMIN_ACCESS, 'lamp', { label: 'Lamp', driver: 'stub', class: 'light' });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'power', 'log', { label: 'Power', unit: 'W', deviceClass: 'power' });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'switch', 'control', { label: 'Switch', schema: { type: 'bool' } });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'button', 'log', { label: 'Button', events: true });
      await admin.execString("mkqueue -k 'dev.lamp.#' /home/admin/lamp");

      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'power', 41.8), true);
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'power', 41.8), false, 'a repeat is not news');
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'button', 'single'), true);
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'button', 'single'), true, 'each press is an event');

      const lamp = (await bo.execJson<DeviceSummary[]>('devices')).find((device) => device.name === 'lamp');
      assertEquals(lamp?.main, { endpoint: 'power', label: 'Power', value: 41.8, unit: 'W' });
      const queued = await admin.execString('queue-peek /home/admin/lamp');
      assertStringIncludes(queued, '"endpoint":"power"');
      assertEquals((await anna.execJson<DeviceHistory>('device-history lamp/button')).readings.length, 2);
    });

    await t.step('a control is written through its driver as whoever wrote it, and only what it takes', async () => {
      await bo.execString('echo on > /dev/lamp/switch');
      assertEquals(writes.map((write) => [write.device, write.endpoint, write.value, write.by]), [['lamp', 'switch', true, 'bo']]);
      const control = await admin.execJson<{ attrs: { requested?: { value: unknown; by: string } } }>('stat /dev/lamp/switch');
      assertEquals([control.attrs.requested?.value, control.attrs.requested?.by], [true, 'bo']);
      await testCommands(bo).shouldFailWith('echo 7 > /dev/lamp/switch', 'on, off or toggle');
      await testCommands(bo).shouldFailWith('echo on >> /dev/lamp/switch', 'denied');

      // The device reports the state it has; a toggle turns that over.
      await devices.append(ADMIN_ACCESS, 'lamp', 'switch', true);
      assertStringIncludes(await bo.execString('cat /dev/lamp/switch'), 'true');
      await bo.execString('echo toggle > /dev/lamp/switch');
      assertEquals(writes.at(-1)?.value, false);

      unregister();
      await testCommands(bo).shouldFailWith('echo on > /dev/lamp/switch', 'not running');
    });

    await t.step('over HTTP, a value is appended to a log and written to a control', async () => {
      unregister = devices.registerDriver('stub', {
        description: 'a lamp for the test',
        async write(command: DriverWrite) {
          writes.push(command);
        },
      });
      const { cookie } = await harness.createHttpSession();
      const power = await fetch(`${baseUrl}/file/dev/lamp/power`, { method: 'POST', headers: { cookie }, body: '42.5' });
      assertEquals(await power.json(), { appended: 1 });
      assertEquals((await admin.execJson<DeviceHistory>('device-history lamp/power -n 1')).readings.map((reading) => reading.value), [42.5]);
      const off = await fetch(`${baseUrl}/file/dev/lamp/switch`, { method: 'POST', headers: { cookie }, body: 'off' });
      assertEquals(await off.json(), { value: false });
      const refused = await fetch(`${baseUrl}/file/dev/lamp/switch`, { method: 'POST', headers: { cookie }, body: 'maybe' });
      assertEquals(refused.status, 400);
      await refused.body?.cancel();
    });

    await t.step('a member forgets a device, and nobody else does', async () => {
      await testCommands(bo).shouldFailWith('device-forget lamp', 'devices');
      await anna.execString('device-forget lamp');
      assertEquals((await admin.exec('stat /dev/lamp')).success, false);
      unregister();
    });
  } finally {
    for (const client of clients) client.close();
    await harness.stop();
  }
});
