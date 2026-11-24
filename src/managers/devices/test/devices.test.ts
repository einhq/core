/**
 * Devices on a booted EiN: the devices group's /dev, a tracker's track a phone posts to with its key
 * and a GPX file is written to, a driver's readings kept and published, a device shared with someone
 * outside the group, a control written through its driver as whoever wrote it, values over HTTP, a
 * webhook device's posts kept and published, the screens and speakers found by their `show` and the
 * paths written to it, and forgetting a device.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { encodeHex } from '@std/encoding';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import type { AccessLogEntry } from '../../../lib/api/audit.ts';
import type { DeviceAppAnswer, DeviceConfigAnswer, DeviceCreated, DeviceHistory, DeviceInfo, DeviceKeyAnswer, DeviceSummary } from '../../../lib/api/devices.ts';
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

    await t.step("/dev is the administrator's; only the devices group's members make devices, through device-create", async () => {
      const dev = await admin.execJson<{ props: { uid: number; mode: number } }>('stat /dev');
      assertEquals([dev.props.uid, dev.props.mode & 0o7777], [0, 0o755]);
      await testCommands(anna).shouldFailWith('rm /dev/null', 'denied');
      await testCommands(bo).shouldFailWith("device-create 'Bo phone' --driver tracker", 'devices');
      await testCommands(anna).shouldFailWith('device-create null', "core's own");
    });

    await t.step("a phone posts its position with its device's key, and nothing else does", async () => {
      const created = await anna.execJson<DeviceCreated>("device-create 'Ruby phone' --driver tracker --class phone");
      assertEquals(created, { device: 'ruby-phone', path: '/dev/ruby-phone' });
      // The administrator's and the devices group's, whoever asked for it; nobody else's.
      const phone = await admin.execJson<{ props: { uid: number; gid: number; mode: number } }>('stat /dev/ruby-phone');
      const devicesGid = (await admin.execJson<{ gid: number }>('group-info devices')).gid;
      assertEquals([phone.props.uid, phone.props.gid, phone.props.mode & 0o777], [0, devicesGid, 0o770]);
      const key = await anna.execJson<DeviceKeyAnswer>('device-key ruby-phone --new --origin https://ein.example');
      assertEquals([key.enabled, key.url?.startsWith('https://ein.example/file/dev/ruby-phone/position?key='), key.qrSvg?.startsWith('<svg')], [true, true, true]);
      // Traccar Client takes the server from `url` whole, key and all, only from its own scheme.
      const qr = new URL(key.qrText!);
      assertEquals([qr.protocol, qr.searchParams.get('url'), qr.searchParams.get('id')], ['org.traccar.client:', key.url, 'ruby-phone']);
      const secret = new URL(key.url!).searchParams.get('key')!;

      const osmand = await fetch(`${baseUrl}/file/dev/ruby-phone/position?key=${secret}&lat=57.7&lon=11.9&timestamp=1717236000`);
      assertEquals([osmand.status, (await osmand.json()).appended], [200, 1]);
      const traccar = await fetch(`${baseUrl}/file/dev/ruby-phone/position`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { coords: { latitude: 57.71, longitude: 11.91 }, timestamp: '2024-06-01T10:10:00Z' } }),
      });
      assertEquals([traccar.status, (await traccar.json()).appended], [200, 1]);

      const info = await anna.execJson<DeviceInfo>('device-show ruby-phone');
      assertEquals(info.endpointList.map((ep) => [ep.name, ep.type, ep.track?.points]), [['position', 'track', 2]]);

      // What it says of itself goes to logs of its own, made the first time it says it.
      const status = await fetch(`${baseUrl}/file/dev/ruby-phone/position`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: {
            coords: { latitude: 57.711, longitude: 11.911, accuracy: 6 },
            timestamp: '2024-06-01T10:15:00Z',
            battery: { level: 0.42, is_charging: true },
            activity: { type: 'on_foot' },
          },
        }),
      });
      assertEquals([status.status, (await status.json()).appended], [200, 1]);
      const told = await anna.execJson<DeviceInfo>('device-show ruby-phone');
      assertEquals(
        told.endpointList.map((ep) => [ep.name, ep.last?.value ?? null, ep.category ?? null]),
        [['activity', 'on_foot', null], ['battery', 42, 'diagnostic'], ['charging', true, 'diagnostic'], ['position', null, null]],
      );
      assertEquals([told.battery, told.main?.endpoint], [{ level: 42, charging: true }, 'activity']);
      const fixes = (await anna.execJson<DeviceHistory>('device-history ruby-phone/position')).fixes!;
      assertEquals(fixes.at(-1)?.accuracy, 6);
      assertEquals((await anna.execJson<DeviceSummary[]>('devices')).find((device) => device.name === 'ruby-phone')?.battery, { level: 42, charging: true });
      assertEquals([info.driver, info.driverRunning, info.input, info.tracks], ['tracker', true, false, true]);
      // Its driver cannot tell whether it answers: a fix from 2024 says nothing, one from now says online.
      assertEquals(info.online, undefined);
      const now = await fetch(`${baseUrl}/file/dev/ruby-phone/position?key=${secret}&lat=57.72&lon=11.92&timestamp=${Math.floor(Date.now() / 1000)}`);
      await now.body?.cancel();
      const listed = (await anna.execJson<{ name: string; online?: boolean }[]>('devices')).find((device) => device.name === 'ruby-phone');
      assertEquals([(await anna.execJson<DeviceInfo>('device-show ruby-phone')).online, listed?.online], [true, true]);

      const wrong = await fetch(`${baseUrl}/file/dev/ruby-phone/position?key=not-the-key&lat=1&lon=1`);
      await wrong.body?.cancel();
      await anna.execString("device-create 'Old logger' --driver tracker");
      const elsewhere = await fetch(`${baseUrl}/file/dev/old-logger/position?key=${secret}&lat=1&lon=1`);
      await elsewhere.body?.cancel();
      assertEquals([wrong.status, elsewhere.status], [403, 403]);
    });

    await t.step("a GPX file written to a tracker's track fills it, the devices group's; a device with no driver refuses what is written to it", async () => {
      await anna.execString(`echo '${GPX}' > /tmp/walk.gpx`);
      const track = await admin.execJson<{ props: { uid: number; gid: number; mode: number } }>('stat /dev/old-logger/position');
      assertEquals([track.props.uid, track.props.gid, track.props.mode & 0o777], [0, (await admin.execJson<{ gid: number }>('group-info devices')).gid, 0o770]);
      await anna.execString('cat /tmp/walk.gpx > /dev/old-logger/position');
      const history = await anna.execJson<DeviceHistory>('device-history old-logger/position');
      assertEquals(history.fixes?.map((fix) => [fix.at, fix.lat]), [['2024-06-01T10:00:00.000Z', 57.7], ['2024-06-01T10:05:00.000Z', 57.71]]);
      await anna.execString('device-create Thermometer');
      await testCommands(anna).shouldFailWith('echo 21 > /dev/thermometer', 'no driver');
    });

    const writes: DriverWrite[] = [];
    let refuse: string | undefined;
    let unregister = devices.registerDriver('stub', {
      description: 'a lamp for the test',
      async write(command: DriverWrite) {
        if (refuse) throw new Error(refuse);
        writes.push(command);
      },
    });

    await t.step("a driver's readings are kept on its endpoints and published on their keys", async () => {
      await devices.ensureDevice(ADMIN_ACCESS, 'lamp', { label: 'Lamp', driver: 'stub', class: 'light' });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'power', 'log', { label: 'Power', unit: 'W', deviceClass: 'power' });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'switch', 'control', { label: 'Switch', schema: { type: 'bool' } });
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'button', 'log', { label: 'Button', events: true });
      await admin.execString("mkqueue -k 'dev.lamp.#' /home/admin/lamp");
      // Only the administrator binds a queue to what is published: bo would hear every reading.
      await testCommands(bo).shouldFailWith("mkqueue -k 'dev.lamp.#' /home/bo/lamp", 'routingKeys');
      await bo.execString('mkqueue /home/bo/lamp');
      await testCommands(bo).shouldFailWith('attrs -s \'routingKeys=["dev.#"]\' /home/bo/lamp', 'routingKeys');
      // Nor publishes on a key or tails it through a router: bo would hear every device, or forge domain events.
      await testCommands(bo).shouldFailWith("mkrouter -k 'dev.#' /home/bo/tail", 'routingKey');
      await testCommands(bo).shouldFailWith('mkrouter -k system.events /home/bo/events', 'routingKey');
      await bo.execString('mknode -t router /home/bo/local');
      await testCommands(bo).shouldFailWith('attrs -s routingKey=system.events /home/bo/local', 'routingKey');
      await testCommands(bo).shouldFailWith('echo \'{"type":"media.file.discovered","subject":"/home/bo","id":"1","time":1}\' > /dev/events', 'denied');
      await testCommands(bo).shouldFailWith('cat /dev/pipeline-events', 'denied');

      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'power', 41.8), true);
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'power', 41.8), false, 'a repeat is not news');
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'button', 'single'), true);
      assertEquals(await devices.append(ADMIN_ACCESS, 'lamp', 'button', 'single'), true, 'each press is an event');

      const lamp = (await anna.execJson<DeviceSummary[]>('devices')).find((device) => device.name === 'lamp');
      assertEquals(lamp?.main, { endpoint: 'power', label: 'Power', value: 41.8, unit: 'W' });
      assertEquals((await anna.execJson<DeviceSummary[]>('devices LAM no-such')).map((device) => device.name), ['lamp'], 'any word, in any case');
      // A value written by hand is appended, `>` as `>>`, and kept as `{ value }`.
      await admin.execString('echo 40.5 > /dev/lamp/power');
      assertEquals((await anna.execJson<DeviceHistory>('device-history lamp/power')).readings.map((reading) => reading.value), [41.8, 40.5]);
      const queued = await admin.execString('queue-peek /home/admin/lamp');
      assertStringIncludes(queued, '"endpoint":"power"');
      assertEquals((await anna.execJson<DeviceHistory>('device-history lamp/button')).readings.length, 2);
    });

    await t.step("a device's own web page is answered when it is http(s), and nothing else is", async () => {
      await devices.ensureDevice(ADMIN_ACCESS, 'lamp', { url: 'http://192.0.2.30/' });
      assertEquals((await anna.execJson<DeviceInfo>('device-show lamp')).url, 'http://192.0.2.30/');
      await devices.ensureDevice(ADMIN_ACCESS, 'lamp', { url: 'javascript:alert(1)' });
      assertEquals((await anna.execJson<DeviceInfo>('device-show lamp')).url, undefined);
    });

    await t.step('someone outside the devices group sees a device once a member shares it, what it gets later too', async () => {
      assertEquals((await bo.execJson<DeviceSummary[]>('devices')).map((device) => device.name), []);
      await testCommands(bo).shouldFailWith('device-history lamp/power', 'denied');

      await anna.execString('share-set -m u:bo:rx /dev/lamp');
      assertEquals((await bo.execJson<DeviceSummary[]>('devices')).map((device) => [device.name, device.writable]), [['lamp', false]]);
      assertEquals((await bo.execJson<DeviceHistory>('device-history lamp/power')).readings.map((reading) => reading.value), [41.8, 40.5]);
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'motion', 'log', { label: 'Motion', deviceClass: 'motion' });
      await devices.append(ADMIN_ACCESS, 'lamp', 'motion', true);
      assertEquals((await bo.execJson<DeviceHistory>('device-history lamp/motion')).readings.map((reading) => reading.value), [true]);
      await testCommands(bo).shouldFailWith('echo on > /dev/lamp/switch', 'denied');

      // An endpoint narrowed further is left out of the device for them, not an error.
      await anna.execString('share-set -x u:bo /dev/lamp/motion');
      assertEquals((await bo.execJson<DeviceInfo>('device-show lamp')).endpointList.map((endpoint) => endpoint.name), ['button', 'power', 'switch']);

      await anna.execString('share-set -m u:bo:rwx /dev/lamp');
      assertEquals((await bo.execJson<DeviceSummary[]>('devices')).map((device) => [device.name, device.writable]), [['lamp', true]]);
    });

    await t.step('the screens and speakers are the devices with a show the caller may write and a driver to take it, which takes paths as the writer', async () => {
      const shown: { value: unknown; uid: number }[] = [];
      const unregisterScreen = devices.registerDriver('screen', {
        description: 'a screen for the test',
        async write(command) {
          shown.push({ value: command.value, uid: command.access.uid });
          return { message: 'showing it' };
        },
      });
      try {
        await devices.ensureDevice(ADMIN_ACCESS, 'hall-tv', { label: 'Hall TV', driver: 'screen', class: 'media' });
        await devices.ensureEndpoint(ADMIN_ACCESS, 'hall-tv', 'show', 'control', { label: 'Show', schema: { type: 'text', lines: true } });
        assertEquals((await anna.execJson<DeviceSummary[]>('devices --endpoint show')).map((device) => device.name), ['hall-tv']);
        await anna.execString("printf '/media?q=sailboat&slideshow=screen\\n/albums/Summer\\n' > /dev/hall-tv/show");
        assertEquals(shown.map((each) => [each.value, each.uid === ADMIN_ACCESS.uid]), [['/media?q=sailboat&slideshow=screen\n/albums/Summer', false]]);
        assertEquals(await devices.command(ADMIN_ACCESS, '/dev/hall-tv/show', '/albums/Summer\n'), { value: '/albums/Summer', message: 'showing it' });
      } finally {
        unregisterScreen();
      }
      assertEquals(await anna.execJson<DeviceSummary[]>('devices --endpoint show'), []);
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

      // A press is recorded once the driver took it, not when it refused it.
      await devices.ensureEndpoint(ADMIN_ACCESS, 'lamp', 'chime', 'control', { label: 'Chime', schema: { type: 'momentary' } });
      refuse = 'nothing to chime';
      await testCommands(bo).shouldFailWith('echo press > /dev/lamp/chime', 'nothing to chime');
      const pressed = () => admin.execJson<{ attrs: { requested?: { by: string } } }>('stat /dev/lamp/chime');
      assertEquals((await pressed()).attrs.requested, undefined);
      refuse = undefined;
      await bo.execString('echo press > /dev/lamp/chime');
      assertEquals((await pressed()).attrs.requested?.by, 'bo');

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

    await t.step("a webhook device's posts are readings on endpoints made as they come, kept and published", async () => {
      await anna.execString("device-create 'Porch' --driver webhook --config events=button");
      const key = await anna.execJson<DeviceKeyAnswer>('device-key porch --new --origin https://ein.example');
      const secret = new URL(key.url!).searchParams.get('key')!;
      await admin.execString("mkqueue -k 'dev.porch.#' /home/admin/porch");
      const post = (body: string, query = '') =>
        fetch(`${baseUrl}/file/dev/porch${query}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body });

      const first = await post('{"temperature": 21.4, "button": "single", "env": {"lux": 300}}');
      assertEquals([first.status, (await first.json()).taken], [200, 3]);
      const again = await post('{"temperature": 21.4, "button": "single"}');
      assertEquals((await again.json()).taken, 1, 'a repeated reading is not news, a press is');
      const pressed = await fetch(`${baseUrl}/file/dev/porch?key=${secret}`);
      assertEquals((await pressed.json()).taken, 1);

      const info = await anna.execJson<DeviceInfo>('device-show porch');
      assertEquals(info.endpointList.map((ep) => [ep.name, ep.type]), [['button', 'log'], ['call', 'log'], ['env-lux', 'log'], ['temperature', 'log']]);
      assertEquals((await anna.execJson<DeviceHistory>('device-history porch/button')).readings.length, 2);
      const queued = await admin.execString('queue-peek -n 10 /home/admin/porch');
      for (const endpoint of ['temperature', 'button', 'env-lux', 'call']) assertStringIncludes(queued, `"endpoint":"${endpoint}"`);
      assertStringIncludes(queued, '"device":"porch"');

      const wrong = await fetch(`${baseUrl}/file/dev/porch?key=not-the-key&temperature=1`);
      await wrong.body?.cancel();
      assertEquals(wrong.status, 403);
    });

    await t.step('a write nobody may make is refused before its body is read, and a body over its limit is 413', async () => {
      let sent = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      const guest = await fetch(`${baseUrl}/file/dev/porch`, { method: 'POST', body: endless });
      await guest.body?.cancel();
      assertEquals(guest.status, 403);
      assert(sent < 4 * 1024 * 1024, `${sent} bytes were taken before the refusal`);

      const key = await anna.execJson<DeviceKeyAnswer>('device-key porch --new --origin https://ein.example');
      const secret = new URL(key.url!).searchParams.get('key')!;
      const large = await fetch(`${baseUrl}/file/dev/porch`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: new Uint8Array(5 * 1024 * 1024) });
      await large.body?.cancel();
      assertEquals(large.status, 413);
    });

    await t.step(
      'the EiN app pairs with a phone by a one-time code, posts its fixes, sends and asks about files and opens sessions as whoever paired it, until it is unpaired',
      async () => {
        await testCommands(admin).shouldFailWith('device-app ruby-phone --pair --origin https://ein.example', 'never as the administrator');
        await testCommands(bo).shouldFailWith('device-app ruby-phone --pair --origin https://ein.example', 'denied');
        await testCommands(anna).shouldFailWith('device-app ruby-phone --pair', '--origin');
        assertEquals((await anna.execJson<DeviceAppAnswer>('device-app ruby-phone')).paired, false);

        const shown = await anna.execJson<DeviceAppAnswer>('device-app ruby-phone --pair --origin https://ein.example');
        const qr = new URL(shown.qrText!);
        assertEquals([qr.protocol, qr.searchParams.get('server'), qr.searchParams.get('device'), shown.qrSvg?.startsWith('<svg')], [
          'ein:',
          'https://ein.example',
          'ruby-phone',
          true,
        ]);
        const code = qr.searchParams.get('code')!;
        // Shown once: reading the pairing again says only until when the code works.
        const again = await anna.execJson<DeviceAppAnswer>('device-app ruby-phone');
        assertEquals([again.qrText, typeof again.pairingExpiresAt], [undefined, 'string']);

        const pair = (body: unknown) => fetch(`${baseUrl}/__app/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const wrong = await pair({ device: 'ruby-phone', code: 'A'.repeat(22) });
        await wrong.body?.cancel();
        assertEquals(wrong.status, 403);
        const paired = await pair({ device: 'ruby-phone', code, install: 'eeee5555' });
        const { token, user } = await paired.json() as { token: string; user: string };
        assertEquals([paired.status, user, token.startsWith('ruby-phone.')], [200, 'anna', true]);
        // The app's installation is kept on the phone, so signing in with a password finds it again.
        assertEquals((await admin.execJson<{ attrs: { install?: string } }>('stat /dev/ruby-phone')).attrs.install, 'eeee5555');
        const reused = await pair({ device: 'ruby-phone', code });
        await reused.body?.cancel();
        assertEquals(reused.status, 403);

        // Its fixes are anna's writes to the phone's track; its token opens no other device.
        const fix = await fetch(`${baseUrl}/file/dev/ruby-phone/position`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ location: { coords: { latitude: 57.73, longitude: 11.93 }, timestamp: new Date().toISOString() } }),
        });
        assertEquals([fix.status, (await fix.json()).appended], [200, 1]);
        const elsewhere = await fetch(`${baseUrl}/file/dev/old-logger/position?key=${token}&lat=1&lon=1`);
        await elsewhere.body?.cancel();
        assertEquals(elsewhere.status, 403);

        // It sends files in pieces that resume, as anna.
        const tus = { Authorization: `Bearer ${token}`, 'Tus-Resumable': '1.0.0' };
        const upload = (headers: Record<string, string>) =>
          fetch(`${baseUrl}/upload/`, {
            method: 'POST',
            headers: { ...headers, 'Upload-Length': '5', 'Upload-Metadata': `filename ${btoa('clip.mp4')},dir ${btoa('/home/anna')}` },
          });
        const begun = await upload(tus);
        await begun.body?.cancel();
        const piece = await fetch(`${baseUrl}${begun.headers.get('location')}`, {
          method: 'PATCH',
          headers: { ...tus, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
          body: 'bytes',
        });
        await piece.body?.cancel();
        assertEquals([begun.status, piece.status, piece.headers.get('content-location')], [201, 204, '/file/home/anna/clip.mp4']);
        const [clip, home] = await Promise.all(['/home/anna/clip.mp4', '/home/anna'].map((path) => admin.execJson<{ uid: number }>(`props ${path}`)));
        assertEquals(clip.uid, home.uid);

        // It asks which files anna has already before it sends them.
        const clipSha = encodeHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bytes')));
        const checksums = () =>
          fetch(`${baseUrl}/checksums`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ sha256: [clipSha, 'a'.repeat(64)] }) });
        const asked = await checksums();
        assertEquals([asked.status, await asked.json()], [200, { known: [clipSha] }]);

        // A session for its WebView, sent on to a path of this server and never another site's.
        const session = await fetch(`${baseUrl}/__app/session?next=/devices`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
        await session.body?.cancel();
        assertEquals([session.status, session.headers.get('location')], [303, '/devices']);
        const cookie = session.headers.get('set-cookie')!.split(';')[0];
        const offsite = await fetch(`${baseUrl}/__app/session?next=//evil.example/`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
        await offsite.body?.cancel();
        assertEquals(offsite.headers.get('location'), '/');
        const signedIn = await fetch(`${baseUrl}/__session`, { headers: { cookie } });
        await signedIn.body?.cancel();
        assertEquals(signedIn.status, 204);

        const state = await anna.execJson<DeviceAppAnswer>('device-app ruby-phone');
        assertEquals([state.paired, state.user, typeof state.lastUsedAt, state.pairingExpiresAt], [true, 'anna', 'string', undefined]);
        const log = await admin.execJson<AccessLogEntry[]>('access-log --user anna --event sign-in');
        assertEquals(log.filter((entry) => entry.via === 'app').map((entry) => entry.method).sort(), ['pairing', 'token', 'token']);

        // Unpaired, the token and the sessions it opened stop working at once.
        await anna.execString('device-app ruby-phone --off');
        const ended = await fetch(`${baseUrl}/__session`, { headers: { cookie } });
        await ended.body?.cancel();
        const refusedFix = await fetch(`${baseUrl}/file/dev/ruby-phone/position?key=${token}&lat=1&lon=1`);
        await refusedFix.body?.cancel();
        const refusedSession = await fetch(`${baseUrl}/__app/session`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
        await refusedSession.body?.cancel();
        const refusedUpload = await upload(tus);
        await refusedUpload.body?.cancel();
        const refusedChecksums = await checksums();
        await refusedChecksums.body?.cancel();
        assertEquals([ended.status, refusedFix.status, refusedSession.status, refusedUpload.status, refusedChecksums.status], [401, 403, 403, 401, 401]);
        assertEquals((await anna.execJson<DeviceAppAnswer>('device-app ruby-phone')).paired, false);

        // The app unpairs itself with its token, which ends its sessions as --off does, and works once.
        const repaired = await pair({
          device: 'ruby-phone',
          code: new URL((await anna.execJson<DeviceAppAnswer>('device-app ruby-phone --pair --origin https://ein.example')).qrText!).searchParams.get('code'),
        });
        const { token: second } = await repaired.json() as { token: string };
        const reopened = await fetch(`${baseUrl}/__app/session`, { headers: { Authorization: `Bearer ${second}` }, redirect: 'manual' });
        await reopened.body?.cancel();
        const secondCookie = reopened.headers.get('set-cookie')!.split(';')[0];
        const unpair = () => fetch(`${baseUrl}/__app/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${second}` } });
        const unpaired = await unpair();
        await unpaired.body?.cancel();
        const secondEnded = await fetch(`${baseUrl}/__session`, { headers: { cookie: secondCookie } });
        await secondEnded.body?.cancel();
        const unpairedAgain = await unpair();
        await unpairedAgain.body?.cancel();
        assertEquals([unpaired.status, secondEnded.status, unpairedAgain.status], [204, 401, 403]);
        assertEquals((await anna.execJson<DeviceAppAnswer>('device-app ruby-phone')).paired, false);
        const signedOut = await admin.execJson<AccessLogEntry[]>('access-log --user anna --event sign-out');
        assertEquals(signedOut.filter((entry) => entry.via === 'app').map((entry) => entry.method), ['token']);
      },
    );

    await t.step(
      'the EiN app signs in with a password as a phone the account may change, the one its installation was paired as, or a new one for the devices group',
      async () => {
        // From an address of its own, which the failures of the steps before have not slowed.
        const from = { 'X-Forwarded-For': '192.0.2.34' };
        const signIn = async (body: Record<string, unknown>) => {
          const answer = await fetch(`${baseUrl}/__app/sign-in`, { method: 'POST', headers: { ...from, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return { status: answer.status, body: answer.headers.get('content-type')?.includes('json') ? await answer.json() : await answer.text() };
        };
        const wrong = await signIn({ user: 'anna', password: 'wrong', install: 'aaaa1111' });
        const administrator = await signIn({ user: 'admin', password: 'admin', install: 'aaaa1111' });
        const malformed = await signIn({ user: 'anna', password: 'hunter2' });
        assertEquals([wrong.status, administrator.status, malformed.status], [403, 403, 400]);
        assertStringIncludes(administrator.body, 'never acts as the administrator');

        // Nothing marks this installation yet: anna chooses among the phones she may change, or a new one.
        const choose = await signIn({ user: 'anna', password: 'hunter2', install: 'aaaa1111', label: 'Anna Pixel' });
        assertEquals([choose.status, choose.body.create, choose.body.label], [409, true, 'Anna Pixel']);
        assertEquals(choose.body.phones, [{ device: 'ruby-phone', label: 'Ruby phone', paired: false }]);

        const chosen = await signIn({ user: 'anna', password: 'hunter2', install: 'aaaa1111', device: 'ruby-phone' });
        assertEquals([chosen.status, chosen.body.device, chosen.body.user, chosen.body.token.startsWith('ruby-phone.')], [200, 'ruby-phone', 'anna', true]);
        assertEquals((await admin.execJson<{ attrs: { install?: string } }>('stat /dev/ruby-phone')).attrs.install, 'aaaa1111');
        // Signing in again from the same installation finds the phone, and its token replaces the one before.
        const again = await signIn({ user: 'anna', password: 'hunter2', install: 'aaaa1111' });
        assertEquals([again.status, again.body.device], [200, 'ruby-phone']);
        const stale = await fetch(`${baseUrl}/__app/session`, { headers: { ...from, Authorization: `Bearer ${chosen.body.token}` }, redirect: 'manual' });
        await stale.body?.cancel();
        const fresh = await fetch(`${baseUrl}/__app/session`, { headers: { ...from, Authorization: `Bearer ${again.body.token}` }, redirect: 'manual' });
        await fresh.body?.cancel();
        assertEquals([stale.status, fresh.status], [403, 303]);

        // Another installation makes a new phone of its own, which takes its fixes.
        const made = await signIn({ user: 'anna', password: 'hunter2', install: 'bbbb2222', label: 'Anna Pixel', manufacturer: 'Google', model: 'Pixel 9', create: true });
        assertEquals([made.status, made.body.device], [200, 'anna-pixel']);
        const phone = await admin.execJson<{ attrs: Record<string, string> }>('stat /dev/anna-pixel');
        assertEquals([phone.attrs.label, phone.attrs.class, phone.attrs.driver, phone.attrs.model, phone.attrs.install], [
          'Anna Pixel',
          'phone',
          'tracker',
          'Pixel 9',
          'bbbb2222',
        ]);
        const fix = await fetch(`${baseUrl}/file/dev/anna-pixel/position`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${made.body.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ location: { coords: { latitude: 57.73, longitude: 11.93 }, timestamp: new Date().toISOString() } }),
        });
        assertEquals([fix.status, (await fix.json()).appended], [200, 1]);
        // The same name again is the next free one; the installation it moved to is no longer marked on the first phone.
        const second = await signIn({ user: 'anna', password: 'hunter2', install: 'aaaa1111', label: 'Anna Pixel', create: true, device: undefined });
        assertEquals([second.status, second.body.device], [200, 'ruby-phone']);
        const moved = await signIn({ user: 'anna', password: 'hunter2', install: 'bbbb2222', device: 'ruby-phone' });
        assertEquals([moved.status, (await admin.execJson<{ attrs: { install?: string } }>('stat /dev/anna-pixel')).attrs.install], [200, undefined]);
        const renamed = await signIn({ user: 'anna', password: 'hunter2', install: 'cccc3333', label: 'Anna Pixel', create: true });
        assertEquals(renamed.body.device, 'anna-pixel-2');

        // bo may change no phone and make none: he chooses from nothing, and pairs none by name.
        const bos = await signIn({ user: 'bo', password: 'hunter2', install: 'dddd4444', create: true });
        assertEquals([bos.status, bos.body.phones, bos.body.create], [409, [], false]);
        const notHis = await signIn({ user: 'bo', password: 'hunter2', install: 'dddd4444', device: 'ruby-phone' });
        assertEquals(notHis.status, 403);

        const log = await admin.execJson<AccessLogEntry[]>('access-log --user anna --event sign-in');
        assert(log.some((entry) => entry.via === 'app' && entry.method === 'password'));
        await anna.execString('device-forget anna-pixel && device-forget anna-pixel-2');
      },
    );

    await t.step("the user and password an address carries go to the driver's user and secret password, not its config", async () => {
      const stop = devices.registerDriver('web', {
        description: 'a web API for the test',
        config: [
          { name: 'url', label: 'Address', type: 'url', required: true },
          { name: 'user', label: 'User', type: 'string' },
          { name: 'password', label: 'Password', type: 'string', secret: true },
        ],
      });
      const plain = devices.registerDriver('plain', { description: 'keeps no password', config: [{ name: 'url', label: 'Address', type: 'url' }] });
      try {
        await anna.execString("device-create Meter --driver web --config 'url=http://cam%20user:S3cret%3Apw@192.0.2.40/{date}/r.json'");
        assertEquals(await anna.execJson<DeviceConfigAnswer>('device-config meter').then((answer) => [answer.config, answer.secrets]), [
          { url: 'http://192.0.2.40/{date}/r.json', user: 'cam user' },
          ['password'],
        ]);
        assertEquals(await devices.secret(ADMIN_ACCESS, 'meter'), { password: 'S3cret:pw' });

        await anna.execString("device-config meter 'url=https://other:n3w@192.0.2.41/r.json'");
        assertEquals((await anna.execJson<DeviceConfigAnswer>('device-config meter')).config, { url: 'https://192.0.2.41/r.json', user: 'other' });
        assertEquals(await devices.secret(ADMIN_ACCESS, 'meter'), { password: 'n3w' });

        const refused = await anna.exec("device-config meter 'url=http://a:pw1@192.0.2.40/' password=pw2");
        assertEquals(refused.success, false);
        assertStringIncludes(refused.error ?? '', 'differs');
        assert(!refused.error?.includes('pw1'), 'the password is not said');
        await testCommands(anna).shouldFailWith("device-config meter 'url=http://192.0.2.40/?next=http://a:pw@192.0.2.41/'", 'inside it');
        await testCommands(anna).shouldFailWith("device-create Other --driver plain --config 'url=http://a:pw@192.0.2.40/'", 'keeps no password');
        assertEquals((await admin.exec('stat /dev/other')).success, false);
      } finally {
        await anna.execString('device-forget meter');
        stop();
        plain();
      }
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
