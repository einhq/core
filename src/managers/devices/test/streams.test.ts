/**
 * A camera's streams on a booted EiN, through a stub driver: a secret config field kept in the
 * device's `.secret` for the administrator alone and changed with `device-config`, a stream endpoint
 * shown with what it is, its bytes from its writer read with `cat` and over HTTP by whoever may read
 * it, a picture over HTTP from a stream of pictures, made when asked, a file ticket reading a stream
 * as live, a stream under a mount read alike, nothing appended to a stream nor written by its
 * readers, and a stream watched live only when it is fragmented MP4 and its driver runs.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import { isStreamWriter } from '../../../registries/stream/mod.ts';
import { accessOfUid } from '../../../lib/auth/member-gids.ts';
import type { DeviceConfigAnswer, DeviceInfo, DeviceSummary } from '../../../lib/api/devices.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ boot: true, ssh: false });

/** The smallest JPEG a stub camera gives: its start and end markers around a 2×1 frame header. */
const FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

Deno.test({ name: 'streams', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  const admin = await harness.createShellClient();
  const clients: ShellClient[] = [admin];
  const setUp: string[] = [];
  const unregister = devices.registerDriver('stub-camera', {
    description: 'a camera for the test',
    config: [
      { name: 'url', label: 'Stream address', type: 'url', required: true },
      { name: 'password', label: 'Password', type: 'string', secret: true },
    ],
    async setup(device) {
      setUp.push(device);
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'main.ts', 'stream', { label: 'Main stream', mimetype: 'video/mp2t', codec: 'h264', width: 1280, height: 720 });
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'main.mp4', 'stream', { label: 'Main stream', mimetype: 'video/mp4', codec: 'h264', width: 1280, height: 720 });
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'sub.ts', 'stream', { label: 'Smaller stream', mimetype: 'video/mp2t', width: 640, height: 360 });
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'main.jpg', 'stream', { label: 'Main picture', mimetype: 'image/jpeg', width: 1280, height: 720 });
      await devices.ensureEndpoint(ADMIN_ACCESS, device, 'sub.jpg', 'stream', { label: 'Smaller picture', mimetype: 'image/jpeg', width: 640, height: 360 });
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

    await t.step("device-config changes the driver's config and its secret, and sets the device up again", async () => {
      const shown = await anna.execJson<DeviceConfigAnswer>('device-config front-door');
      assertEquals([shown.driver, shown.running, shown.config, shown.secrets], ['stub-camera', true, { url: 'rtsp://192.0.2.10/main' }, ['password']]);
      assertEquals(shown.fields.map((field) => field.name), ['url', 'password']);
      const before = setUp.length;
      const changed = await anna.execJson<DeviceConfigAnswer>("device-config front-door url=rtsp://192.0.2.11/main password='n3w pass'");
      assertEquals([changed.config, changed.secrets], [{ url: 'rtsp://192.0.2.11/main' }, ['password']]);
      assertEquals(await devices.secret(ADMIN_ACCESS, 'front-door'), { password: 'n3w pass' });
      assertEquals(setUp.length, before + 1);
      assertEquals(await anna.execString('JSON_OUTPUT=0 device-config front-door'), 'url=rtsp://192.0.2.11/main\npassword=(secret)\n');
      await testCommands(anna).shouldFailWith('device-config front-door colour=red', 'takes no colour');
      await testCommands(anna).shouldFailWith('device-config front-door url=', 'needs url');
      await testCommands(bo).shouldFailWith('device-config front-door password=x', 'devices');
      await anna.execString('device-config front-door password=');
      assertEquals(await devices.secret(ADMIN_ACCESS, 'front-door'), {});
      await anna.execString('device-config front-door password=s3cret');
    });

    await t.step('a stream is shown with what it is and, when it is fragmented MP4, that it is watched live, and a card shows the smallest stream of pictures', async () => {
      const info = await anna.execJson<DeviceInfo>('device-show front-door');
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.stream, endpoint.live]), [
        ['main.jpg', 'stream', { mimetype: 'image/jpeg', width: 1280, height: 720 }, undefined],
        ['main.mp4', 'stream', { mimetype: 'video/mp4', codec: 'h264', width: 1280, height: 720 }, true],
        ['main.ts', 'stream', { mimetype: 'video/mp2t', codec: 'h264', width: 1280, height: 720 }, undefined],
        ['sub.jpg', 'stream', { mimetype: 'image/jpeg', width: 640, height: 360 }, undefined],
        ['sub.ts', 'stream', { mimetype: 'video/mp2t', width: 640, height: 360 }, undefined],
      ]);
      const card = (await anna.execJson<DeviceSummary[]>('devices')).find((device) => device.name === 'front-door');
      assertEquals(card?.picture, 'sub.jpg');
      assertEquals((await anna.execJson<{ readings: unknown[] }>('device-history front-door/main.ts')).readings, []);
      assertStringIncludes(await anna.execString('JSON_OUTPUT=0 device-show front-door'), '  main.ts  stream  1280x720 h264\n');
    });

    await t.step("a stream's bytes come from its writer, read with cat and over HTTP by whoever may read it", async () => {
      const writer = await vfs.open(ADMIN_ACCESS, '/dev/front-door/sub.ts', { mode: 'w' });
      assert(isStreamWriter(writer));
      /** Write `parts` once someone reads, then close: what the readers there then get, to their end. */
      const feed = async (parts: string[]) => {
        while (!writer.wanted) await new Promise((resolve) => setTimeout(resolve, 10));
        for (const part of parts) await writer.write(new TextEncoder().encode(part));
      };
      const counted = anna.execString('cat /dev/front-door/sub.ts | wc -c');
      const cookie = await cookieOf('anna');
      const response = await fetch(`${baseUrl}/file/dev/front-door/sub.ts`, { headers: { cookie } });
      assertEquals([response.status, response.headers.get('content-type'), response.headers.get('cache-control')], [200, 'video/mp2t', 'no-store']);
      // Both have joined once the stream holds two readers.
      while ((await vfs.stat(ADMIN_ACCESS, '/dev/front-door/sub.ts') as { readers?: number }).readers !== 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await feed(['live ', 'bytes']);
      await writer.close();
      assertEquals(await response.text(), 'live bytes');
      assertEquals((await counted).trim(), '10');
      const refused = await fetch(`${baseUrl}/file/dev/front-door/sub.ts`, { headers: { cookie: await cookieOf('bo') } });
      assert(refused.status === 403 || refused.status === 404, `bo got ${refused.status}`);
      await refused.body?.cancel();
    });

    await t.step('a file ticket reads a stream from its latest start point, which a DLNA renderer is told is live', async () => {
      const { uid } = (await admin.execJson<{ attrs: { uid: number } }>('stat /etc/users/anna')).attrs;
      const ticket = await devices.fileTicket((await accessOfUid(vfs, uid))!, '/dev/front-door/sub.ts');
      const writer = await vfs.open(ADMIN_ACCESS, '/dev/front-door/sub.ts', { mode: 'w' });
      assert(isStreamWriter(writer));
      await writer.writeHeader(new TextEncoder().encode('[header] '));
      await writer.writeStart(new TextEncoder().encode('key '));
      await writer.write(new TextEncoder().encode('since '));
      const response = await fetch(`${baseUrl}/file/dev/front-door/sub.ts?ticket=${ticket}`, { headers: { 'getcontentFeatures.dlna.org': '1' } });
      assertEquals(response.status, 200);
      assertStringIncludes(response.headers.get('contentfeatures.dlna.org') ?? '', 'DLNA.ORG_OP=00');
      while ((await vfs.stat(ADMIN_ACCESS, '/dev/front-door/sub.ts') as { readers?: number }).readers !== 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await writer.write(new TextEncoder().encode('now'));
      await writer.close();
      assertEquals(await response.text(), '[header] key since now');
      devices.dropFileTicket(ticket);
    });

    await t.step('a stream under a mount is read over HTTP as one elsewhere', async () => {
      await admin.execString('mknode -t stream /tmp/mounted.ts --as mimetype=video/mp2t');
      const writer = await vfs.open(ADMIN_ACCESS, '/tmp/mounted.ts', { mode: 'w' });
      assert(isStreamWriter(writer));
      await writer.writeStart(new TextEncoder().encode('from a keyframe'));
      const response = await fetch(`${baseUrl}/file/tmp/mounted.ts`, { headers: { cookie: (await harness.createHttpSession(ADMIN_ACCESS)).cookie } });
      assertEquals(response.status, 200);
      const reader = response.body!.getReader();
      assertEquals(new TextDecoder().decode((await reader.read()).value), 'from a keyframe');
      await reader.cancel();
      await writer.close();
    });

    await t.step("a stream is written with the shell's redirect by whoever may write it", async () => {
      await admin.execString('mknode -t stream /home/admin/probe.ts');
      const reader = await vfs.open(ADMIN_ACCESS, '/home/admin/probe.ts', { mode: 'r' });
      try {
        await admin.execString('echo hello > /home/admin/probe.ts');
        assertEquals(new TextDecoder().decode(await reader.read(64)), 'hello\n');
      } finally {
        await reader.close();
      }
    });

    await t.step('a picture is read over HTTP by whoever may read the stream of pictures, made while one is asked for, never cached', async () => {
      const writer = await vfs.open(ADMIN_ACCESS, '/dev/front-door/sub.jpg', { mode: 'w' });
      assert(isStreamWriter(writer));
      const made: boolean[] = [];
      writer.onWanted((wanted) => {
        made.push(wanted);
        if (wanted) void writer.write(FRAME);
      });
      const cookie = await cookieOf('anna');
      const response = await fetch(`${baseUrl}/file/dev/front-door/sub.jpg`, { headers: { cookie } });
      assertEquals([response.status, response.headers.get('content-type'), response.headers.get('cache-control')], [200, 'image/jpeg', 'no-store']);
      assertEquals(new Uint8Array(await response.arrayBuffer()), FRAME);
      // A second read while the picture is fresh is given it, and asks the writer for none.
      assertEquals(new Uint8Array(await (await fetch(`${baseUrl}/file/dev/front-door/sub.jpg`, { headers: { cookie } })).arrayBuffer()), FRAME);
      assertEquals([made, writer.wanted], [[true, false], false]);
      const refused = await fetch(`${baseUrl}/file/dev/front-door/sub.jpg`, { headers: { cookie: await cookieOf('bo') } });
      assert(refused.status === 403 || refused.status === 404, `bo got ${refused.status}`);
      await refused.body?.cancel();
      await writer.close();
    });

    await t.step('nothing is appended to a stream, and those who read it do not write it', async () => {
      const appended = await devices.append(ADMIN_ACCESS, 'front-door', 'main.ts', 1).then(() => 'taken', (error: Error) => error.message);
      assertStringIncludes(appended, 'nothing keeps');
      await testCommands(anna).shouldFailWith('echo x > /dev/front-door/main.ts', 'denied');
    });

    await t.step('a stream is watched live whatever its driver, but not while its driver is not running', async () => {
      const unregisterStill = devices.registerDriver('still-camera', {
        description: 'a camera with pictures alone, for the test',
      });
      try {
        await devices.ensureDevice(ADMIN_ACCESS, 'porch', { label: 'Porch', driver: 'still-camera', class: 'camera' });
        await devices.ensureEndpoint(ADMIN_ACCESS, 'porch', 'main.mp4', 'stream', { label: 'Main stream', mimetype: 'video/mp4' });
        const live = async (device: string) => (await anna.execJson<DeviceInfo>(`device-show ${device}`)).endpointList.map((endpoint) => endpoint.live);
        assertEquals(await live('porch'), [true]);
        unregister();
        assertEquals(await live('front-door'), [undefined, undefined, undefined, undefined, undefined]);
      } finally {
        unregisterStill();
      }
    });
  } finally {
    unregister();
    for (const client of clients) client.close();
    await harness.stop();
  }
});
