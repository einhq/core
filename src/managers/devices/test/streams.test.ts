/**
 * A camera's streams on a booted EiN, through a stub driver: a secret config field kept in the
 * device's `.secret` for the administrator alone, a stream endpoint shown with what it is, a frame
 * read with `cat` and over HTTP for whoever may read it, the live socket passed through to where the
 * driver says with its credentials, the stream's address for a service, and nothing appended to a
 * stream.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import { accessOfUid } from '../../../lib/auth/member-gids.ts';
import type { DeviceInfo, DeviceSummary } from '../../../lib/api/devices.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../testing/mod.ts';
import type { DriverStream } from '../types.ts';

const harness = new SystemTestHarness({ boot: true, ssh: false });

/** The smallest JPEG a stub camera gives: its start and end markers around a 2×1 frame header. */
const FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

Deno.test({ name: 'streams', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  const admin = await harness.createShellClient();
  const clients: ShellClient[] = [admin];
  // Where the stub's streams are watched: it echoes what it is sent, after the header it was opened with.
  const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (req) => {
    const authorization = req.headers.get('authorization');
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => socket.send(`authorization: ${authorization}`);
    socket.onmessage = (event) => socket.send(`echo: ${event.data}`);
    return response;
  });
  const asked: DriverStream[] = [];
  const unregister = devices.registerDriver('stub-camera', {
    description: 'a camera for the test',
    config: [
      { name: 'url', label: 'Stream address', type: 'url', required: true },
      { name: 'password', label: 'Password', type: 'string', secret: true },
    ],
    async setup(device) {
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'main', 'stream', { label: 'Main stream', codec: 'h264', width: 1280, height: 720 });
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'sub', 'stream', { label: 'Smaller stream', width: 640, height: 360 });
    },
    async frame(stream) {
      asked.push(stream);
      return { bytes: FRAME, type: 'image/jpeg' };
    },
    async source(stream) {
      const secret = await devices.secret(ADMIN_ACCESS, stream.device);
      return `rtsp://ein:${secret.password}@192.0.2.1:8554/${stream.device}-${stream.endpoint}`;
    },
    async live(stream) {
      const secret = await devices.secret(ADMIN_ACCESS, stream.device);
      return { url: `ws://127.0.0.1:${upstream.addr.port}/${stream.endpoint}`, headers: { authorization: `Basic ${btoa(`ein:${secret.password}`)}` } };
    },
  });

  try {
    await admin.execString(
      'user-create anna && user-passwd anna --new-password hunter2 && group-add-member devices anna && user-create bo && user-passwd bo --new-password hunter2',
    );
    const anna = await harness.createShellClient({ username: 'anna', password: 'hunter2' });
    const bo = await harness.createShellClient({ username: 'bo', password: 'hunter2' });
    clients.push(anna, bo);
    /** An HTTP session of the account `name`, with its groups. */
    const cookieOf = async (name: string) => {
      const { uid } = (await admin.execJson<{ attrs: { uid: number } }>(`stat /etc/users/${name}`)).attrs;
      return (await harness.createHttpSession(await accessOfUid(vfs, uid))).cookie;
    };

    await t.step("a secret config field is the device's .secret, which the administrator alone reads", async () => {
      await testCommands(anna).shouldFailWith('device-create Porch --driver stub-camera --config password=x', 'url');
      await anna.execString("device-create 'Front door' --driver stub-camera --config url=rtsp://192.0.2.10/main --config password=s3cret");
      const info = await anna.execJson<DeviceInfo>('device-show front-door');
      assertEquals(info.config, { url: 'rtsp://192.0.2.10/main' });
      assertEquals(await devices.secret(ADMIN_ACCESS, 'front-door'), { password: 's3cret' });
      await testCommands(anna).shouldFailWith('cat /dev/front-door/.secret', 'denied');
    });

    await t.step('a stream is shown with what it is, and a card shows a frame of the smallest', async () => {
      const info = await anna.execJson<DeviceInfo>('device-show front-door');
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.stream]), [
        ['main', 'stream', { codec: 'h264', width: 1280, height: 720 }],
        ['sub', 'stream', { width: 640, height: 360 }],
      ]);
      const card = (await anna.execJson<DeviceSummary[]>('devices')).find((device) => device.name === 'front-door');
      assertEquals(card?.picture, 'sub');
      assertEquals((await anna.execJson<{ readings: unknown[] }>('device-history front-door/main')).readings, []);
      assertStringIncludes(await anna.execString('JSON_OUTPUT=0 device-show front-door'), '  main  stream  1280x720 h264\n');
    });

    await t.step('a frame is read with cat and over HTTP by whoever may read the stream, never cached', async () => {
      assertEquals((await anna.execString('cat /dev/front-door/main | wc -c')).trim(), String(FRAME.length));
      assertEquals(asked.at(-1)?.endpoint, 'main');
      const cookie = await cookieOf('anna');
      const response = await fetch(`${baseUrl}/file/dev/front-door/sub`, { headers: { cookie } });
      assertEquals([response.status, response.headers.get('content-type'), response.headers.get('cache-control')], [200, 'image/jpeg', 'no-store']);
      assertEquals(new Uint8Array(await response.arrayBuffer()), FRAME);
      const refused = await fetch(`${baseUrl}/file/dev/front-door/sub`, { headers: { cookie: await cookieOf('bo') } });
      assert(refused.status === 403 || refused.status === 404, `bo got ${refused.status}`);
      await refused.body?.cancel();
    });

    await t.step("the live socket reaches where the driver says, with the driver's credentials, for a reader alone", async () => {
      const { cookie } = await harness.createHttpSession();
      // Deno's WebSocket takes headers in its options, which its type does not have.
      const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/stream/dev/front-door/main`, { headers: { cookie } } as unknown as string[]);
      const heard: string[] = [];
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => socket.send('hello');
        socket.onmessage = (event) => {
          heard.push(String(event.data));
          if (heard.length === 2) resolve();
        };
        socket.onerror = () => reject(new Error('the live socket failed'));
      });
      socket.close();
      assertEquals(heard, [`authorization: Basic ${btoa('ein:s3cret')}`, 'echo: hello']);

      const refused = await fetch(`${baseUrl}/stream/dev/front-door/main`, { headers: { cookie: await cookieOf('bo'), upgrade: 'websocket' } });
      assert(refused.status === 403 || refused.status === 404, `bo got ${refused.status}`);
      await refused.body?.cancel();
    });

    await t.step("a stream's address for another service is the administrator's alone", async () => {
      assertEquals(await devices.streamSource(ADMIN_ACCESS, 'front-door', 'sub'), 'rtsp://ein:s3cret@192.0.2.1:8554/front-door-sub');
      const anna = await accessOfUid(vfs, (await admin.execJson<{ attrs: { uid: number } }>('stat /etc/users/anna')).attrs.uid);
      const refused = await devices.streamSource(anna!, 'front-door', 'sub').then(() => 'given', (error: Error) => error.message);
      assertStringIncludes(refused, 'only the administrator');
    });

    await t.step('nothing is appended to a stream, nor written to it', async () => {
      const appended = await devices.append(ADMIN_ACCESS, 'front-door', 'main', 1).then(() => 'taken', (error: Error) => error.message);
      assertStringIncludes(appended, 'keeps nothing');
      await testCommands(anna).shouldFailWith('echo x > /dev/front-door/main', 'never written');
    });
  } finally {
    unregister();
    for (const client of clients) client.close();
    await upstream.shutdown();
    await harness.stop();
  }
});
