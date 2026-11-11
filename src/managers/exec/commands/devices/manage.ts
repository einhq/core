import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/constants.ts';
import { verifyAccess } from '../../../../lib/access/verify-access.ts';
import { type DeviceAttrs, type DeviceConfigAnswer, type DeviceCreated, type DeviceKeyAnswer, deviceName } from '../../../../lib/api/devices.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { DEV_PATH, devicePath } from '../../../../lib/paths.ts';
import { isDeviceName, newDeviceKey, readDeviceKey, removeDeviceKey } from '../../../devices/mod.ts';
import { type DeviceNodeAttrs, NODE_TYPE_DEVICE } from '../../../../vfs/types/device.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { assertDevicesMember, fail, parseTarget, qrSvg } from './lib.ts';

/**
 * A device made by a person rather than found by a driver: a phone or a GPS logger (`--driver
 * tracker`), something that posts its readings to a webhook (`--driver webhook`), something a
 * driver reaches at an address it is given (`--config`). What the driver declares secret of its
 * config, a password, goes to the device's `.secret` rather than its attrs; so a driver whose
 * service is not running takes no config. For members of the `devices` group.
 */
export const deviceCreate = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    string: ['label', 'class', 'driver', 'manufacturer', 'model', 'config'],
    collect: ['config'],
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const typed = flags._.map(String).join(' ').trim();
  const device = deviceName(typed);
  if (!device) return await fail(cmd, 'device-create', 'usage: device-create <name> [--driver tracker|webhook] [--class phone] [--label <text>]');
  try {
    await assertDevicesMember(cmd);
    if (!isDeviceName(device)) throw new Error(`'${device}' is core's own in ${DEV_PATH}, not a device's name`);
    if (await cmd.sys.vfs.exists(cmd.access, devicePath(device))) throw new Error(`${device} exists already`);
    const manager = cmd.sys.devices;
    if (!manager) throw new Error('devices are not running here');
    const config: Record<string, string> = {};
    const secret: Record<string, string> = {};
    const driver = flags.driver ? manager.driver(flags.driver) : undefined;
    const secretFields = new Set((driver?.config ?? []).filter((field) => field.secret).map((field) => field.name));
    for (const pair of (flags.config ?? []) as string[]) {
      const at = pair.indexOf('=');
      if (at < 1) throw new Error(`--config takes name=value, not '${pair}'`);
      if (flags.driver && !driver) throw new Error(`the driver ${flags.driver} is not running, so which of its config is secret is not known: start its module first`);
      (secretFields.has(pair.slice(0, at)) ? secret : config)[pair.slice(0, at)] = pair.slice(at + 1);
    }
    for (const field of driver?.config ?? []) {
      if (field.required && !(field.name in config) && !(field.name in secret)) throw new Error(`${flags.driver} needs --config ${field.name}=… (${field.label})`);
    }
    const attrs: DeviceAttrs = {
      label: flags.label || typed,
      ...(flags.class ? { class: flags.class } : {}),
      ...(flags.driver ? { driver: flags.driver } : {}),
      ...(flags.manufacturer ? { manufacturer: flags.manufacturer } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
    // Made as the administrator, since /dev is theirs, and the devices group's as every device is.
    const path = await manager.ensureDevice(ADMIN_ACCESS, device, attrs);
    if (Object.keys(secret).length > 0) await manager.setSecret(device, secret);
    await driver?.setup?.(device);
    const created: DeviceCreated = { device, path };
    if (cmd.json) await cmd.writeJSON(created satisfies DeviceCreated);
    else await cmd.writeLn(path);
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-create', error);
  }
};

deviceCreate.spec = {
  name: 'device-create',
  effect: 'write' as const,
  description: 'Make a device by hand, which no driver announces: a phone or GPS logger (--driver tracker), something that posts its readings to a webhook (--driver webhook)',
  args: [{ name: 'name', type: 'string' as const, description: 'what to call it; its name under /dev is made from it' }],
  flags: [
    { name: 'label', type: 'string' as const, description: 'what its page calls it, when not the name' },
    { name: 'class', type: 'string' as const, description: 'what it is: phone, tracker, boat, car, sensor, …' },
    { name: 'driver', type: 'string' as const, description: "the driver that reads what is written to it: tracker, webhook, or a module's (devices --drivers)" },
    { name: 'manufacturer', type: 'string' as const, description: 'who made it' },
    { name: 'model', type: 'string' as const, description: 'its model' },
    { name: 'config', type: 'string' as const, description: 'name=value for its driver; again for each' },
  ],
  examples: [
    "device-create 'Ruby phone' --driver tracker --class phone",
    "device-create 'Old logger' --driver tracker --class tracker --model 'eTrex 30'",
    "device-create 'Porch' --driver webhook --class button --config events=button",
  ],
  returns: 'DeviceCreated: device, path',
};

/**
 * What a person gave a device's driver, shown to whoever reads the device (a secret field by its name
 * alone), or changed with `name=value` by a member of the `devices` group (an empty value takes a
 * field away): the driver's secret fields to the device's `.secret`, the rest to its attrs, then the
 * driver's `setup` again so it takes the change. Changed only while its driver runs, which says which
 * fields are secret.
 */
export const deviceConfig = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  const pairs = flags._.slice(1).map(String);
  if (!target || target.endpoint) return await fail(cmd, 'device-config', 'usage: device-config <device> [name=value …]');
  const { device } = target;
  try {
    if (pairs.length > 0) await assertDevicesMember(cmd);
    const node = await cmd.sys.vfs.get<DeviceNodeAttrs>(cmd.access, devicePath(device));
    if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${device} is not a device`);
    const manager = cmd.sys.devices;
    if (!manager) throw new Error('devices are not running here');
    const name = node.attrs.driver;
    if (!name) throw new Error(`${device} has no driver, so nothing takes a config`);
    const driver = manager.driver(name);
    const fields = driver?.config ?? [];
    const config = { ...node.attrs.config };
    const secret = await manager.secret(ADMIN_ACCESS, device);
    if (pairs.length > 0) {
      if (!driver) throw new Error(`the driver ${name} is not running, so which of its config is secret is not known: start its module first`);
      const secretFields = new Set(fields.filter((field) => field.secret).map((field) => field.name));
      const known = new Set(fields.map((field) => field.name));
      for (const pair of pairs) {
        const at = pair.indexOf('=');
        if (at < 1) throw new Error(`a config field is name=value, not '${pair}'`);
        const field = pair.slice(0, at);
        if (!known.has(field)) throw new Error(`${name} takes no ${field}; it takes ${[...known].join(', ') || 'no config'}`);
        const into = secretFields.has(field) ? secret : config;
        if (pair.length === at + 1) delete into[field];
        else into[field] = pair.slice(at + 1);
      }
      for (const field of fields) {
        if (field.required && !(field.name in config) && !(field.name in secret)) throw new Error(`${name} needs ${field.name} (${field.label})`);
      }
      await cmd.sys.vfs.update(ADMIN_ACCESS, devicePath(device), { attrs: { config } });
      if (pairs.some((pair) => secretFields.has(pair.slice(0, pair.indexOf('='))))) await manager.setSecret(device, secret);
      await driver.setup?.(device);
    }
    const answer: DeviceConfigAnswer = { device, driver: name, running: driver !== undefined, fields, config, secrets: Object.keys(secret).sort() };
    if (cmd.json) await cmd.writeJSON(answer satisfies DeviceConfigAnswer);
    else {
      for (const [field, value] of Object.entries(config)) await cmd.writeLn(`${field}=${value}`);
      for (const field of answer.secrets) await cmd.writeLn(`${field}=(secret)`);
    }
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-config', error);
  }
};

deviceConfig.spec = {
  name: 'device-config',
  effect: 'read' as const,
  description:
    "Show what a device's driver was given, or change it (name=value, name= to take one away) and have the driver take it up; changing is for members of the devices group",
  args: [
    { name: 'device', type: 'string' as const, description: "the device's name" },
    { name: 'field', type: 'string' as const, description: 'name=value for its driver; name= takes it away; none shows the config', variadic: true, writes: true },
  ],
  examples: ['device-config front-door', "device-config front-door password='n3w pass'", 'device-config front-door sub='],
  returns: 'DeviceConfigAnswer',
};

/** Name a device or an endpoint: what its page and cards call it. For members of the `devices` group. */
export const deviceLabel = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  const label = flags._.slice(1).map(String).join(' ').trim();
  if (!target || !label) return await fail(cmd, 'device-label', 'usage: device-label <device>[/<endpoint>] <label>');
  try {
    await assertDevicesMember(cmd);
    const path = target.endpoint ? join(devicePath(target.device), target.endpoint) : devicePath(target.device);
    await cmd.sys.vfs.update(ADMIN_ACCESS, path, { attrs: { label } });
    if (!cmd.json) await cmd.writeLn(`${target.endpoint ? `${target.device}/${target.endpoint}` : target.device}: ${label}`);
    else await cmd.writeJSON({ path, label });
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-label', error);
  }
};

deviceLabel.spec = {
  name: 'device-label',
  effect: 'write' as const,
  description: 'Name a device or one of its endpoints, as its page and cards show it; for members of the devices group',
  args: [
    { name: 'target', type: 'string' as const, description: '<device> or <device>/<endpoint>' },
    { name: 'label', type: 'string' as const, description: 'the name to show', variadic: true },
  ],
  examples: ["device-label hall-plug 'Hall lamp'", "device-label hall-sensor/temperature 'Hall temperature'"],
  returns: '{ path, label }',
};

/**
 * Remove a device and everything under it, its history included. A driver that finds it again makes
 * it again. For members of the `devices` group.
 */
export const deviceForget = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  if (!target || target.endpoint) return await fail(cmd, 'device-forget', 'usage: device-forget <device>');
  try {
    await assertDevicesMember(cmd);
    const node = await cmd.sys.vfs.get(ADMIN_ACCESS, devicePath(target.device));
    if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${target.device} is not a device`);
    const manager = cmd.sys.devices;
    if (!manager) throw new Error('devices are not running here');
    await manager.forget(ADMIN_ACCESS, target.device);
    if (cmd.json) await cmd.writeJSON({ device: target.device, forgotten: true });
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-forget', error);
  }
};

deviceForget.spec = {
  name: 'device-forget',
  effect: 'write' as const,
  description: 'Remove a device and everything under it, its history included; for members of the devices group',
  args: [{ name: 'device', type: 'string' as const, description: "the device's name" }],
  examples: ['device-forget old-sensor'],
  returns: '{ device, forgotten }',
};

/**
 * The key that lets the device itself write to `/file/dev/<device>` without signing in, and the URL a
 * phone or a tracker is given: shown, made new (the old one stops working) or taken away. For
 * whoever may change the device.
 */
export const deviceKey = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['new', 'off'], string: ['origin'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  if (!target || target.endpoint) return await fail(cmd, 'device-key', 'usage: device-key <device> [--new|--off] [--origin <url>]');
  if (flags.new && flags.off) return await fail(cmd, 'device-key', '--new and --off do not go together');
  let origin: string | undefined;
  if (flags.origin) {
    try {
      origin = new URL(flags.origin).origin;
    } catch {
      return await fail(cmd, 'device-key', `--origin takes a URL such as https://ein.example, not '${flags.origin}'`);
    }
  }
  const { device } = target;
  try {
    const node = await cmd.sys.vfs.get(cmd.access, devicePath(device));
    if (node.type !== NODE_TYPE_DEVICE) throw new Error(`${device} is not a device`);
    if (!verifyAccess(cmd.access, node.props, 'w')) throw new Error(`only whoever may change ${device} sees or changes its key`);
    if (flags.off) await removeDeviceKey(cmd.sys.vfs, device);
    const record = flags.new ? await newDeviceKey(cmd.sys.vfs, device, cmd.access.uid) : flags.off ? undefined : await readDeviceKey(cmd.sys.vfs, device);
    const answer: DeviceKeyAnswer = { device, enabled: record !== undefined };
    if (record) {
      const path = `/file${devicePath(device)}?key=${record.attrs.key}`;
      answer.url = origin ? `${origin}${path}` : path;
      answer.createdAt = new Date(record.attrs.createdAt).toISOString();
      if (origin) {
        // Traccar Client's own link: from an http(s) one it keeps only the origin and path as the
        // server, so the key would be lost; from this one it takes the whole of `url`.
        const config = new URLSearchParams({ url: answer.url, id: device });
        answer.qrText = `org.traccar.client://config?${config}`;
        answer.qrSvg = qrSvg(answer.qrText);
      }
    }
    if (cmd.json) await cmd.writeJSON(answer satisfies DeviceKeyAnswer);
    else await cmd.writeLn(answer.url ?? `${device} has no key: nothing writes to it without signing in`);
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-key', error);
  }
};

deviceKey.spec = {
  name: 'device-key',
  effect: 'write' as const,
  description:
    'The key that lets a device write to /file/dev/<device> without signing in, and the URL a phone or tracker is given: shown, made new (--new) or taken away (--off)',
  args: [{ name: 'device', type: 'string' as const, description: "the device's name" }],
  flags: [
    { name: 'new', type: 'bool' as const, description: 'make a new key; a URL given out before stops working' },
    { name: 'off', type: 'bool' as const, description: 'take the key away: nothing writes to the device without signing in' },
    { name: 'origin', type: 'string' as const, description: "this EiN's address as the device reaches it (https://ein.example), for the whole URL and a QR code" },
  ],
  examples: ['device-key ruby-phone', 'device-key ruby-phone --new --origin https://ein.example', 'device-key old-sensor --off'],
  returns: 'DeviceKeyAnswer',
};
