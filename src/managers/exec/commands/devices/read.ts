import type { DeviceHistory, DeviceInfo, DeviceSummary, DriverSummary, HistoryAggregate } from '../../../../lib/api/devices.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { DEV_PATH } from '../../../../lib/paths.ts';
import { deviceHistory as readHistory, deviceInfo, listDevices } from '../../../devices/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { parseMoment } from '../node/log-read.ts';
import { parseDuration } from '../pool/lib.ts';
import { fail, parseTarget, valueText } from './lib.ts';

const AGGREGATES: HistoryAggregate[] = ['avg', 'min', 'max', 'sum', 'count', 'first', 'last'];

/**
 * Every device the caller may see: its name, label, whether it answers and its main value. With
 * `--drivers`, the drivers instead: core's and those modules' services have registered.
 */
export const devices = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['online', 'drivers'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  try {
    const listed = (await listDevices(cmd.sys.vfs, cmd.access)).filter((device) => !flags.online || device.online === true);
    if (flags.drivers) {
      const manager = cmd.sys.devices;
      const drivers: DriverSummary[] = (manager?.driverNames() ?? []).map((name) => {
        const driver = manager!.driver(name)!;
        return {
          name,
          module: driver.module ?? 'core',
          description: driver.description,
          input: driver.input !== undefined,
          running: true,
          config: driver.config ?? [],
          devices: listed.filter((device) => device.driver === name).length,
        };
      });
      if (cmd.json) await cmd.writeJSON(drivers satisfies DriverSummary[]);
      else for (const driver of drivers) await cmd.writeLn(`${driver.name}  (${driver.module})  ${driver.devices} devices  ${driver.description}`);
      return 0;
    }
    if (cmd.json) {
      await cmd.writeJSON(listed satisfies DeviceSummary[]);
      return 0;
    }
    for (const device of listed) {
      const state = device.online === false ? ' (offline)' : '';
      const main = device.main ? `  ${device.main.label}: ${valueText(device.main.value)}${device.main.unit ? ` ${device.main.unit}` : ''}` : '';
      await cmd.writeLn(`${device.name}  ${device.label}${state}${main}`);
    }
    return 0;
  } catch (error) {
    return await fail(cmd, 'devices', error);
  }
};

devices.spec = {
  name: 'devices',
  effect: 'read' as const,
  description: `Every device under ${DEV_PATH} you may see: its name, label, whether it answers and its main value; or the drivers`,
  flags: [
    { name: 'online', type: 'bool' as const, description: 'only the devices that answer now' },
    { name: 'drivers', type: 'bool' as const, description: "the drivers running now instead: core's, and those modules' services registered" },
  ],
  examples: ['devices', 'devices --online', 'devices --drivers'],
  returns: 'DeviceSummary[], or with --drivers DriverSummary[]',
};

/** A device and each of its endpoints: its latest value, a track's fixes, who may write it. */
export const deviceShow = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  if (!target || target.endpoint) return await fail(cmd, 'device-show', 'usage: device-show <device>');
  try {
    const info = await deviceInfo(cmd.sys.vfs, cmd.access, cmd.sys.devices, target.device);
    if (cmd.json) {
      await cmd.writeJSON(info satisfies DeviceInfo);
      return 0;
    }
    const about = [info.manufacturer, info.model, info.firmware].filter(Boolean).join(' ');
    const driver = info.driver ? `  driver ${info.driver}${info.driverRunning === false ? ' (not running)' : ''}` : '';
    await cmd.writeLn(`${info.label} (${info.name})${about ? `  ${about}` : ''}${info.online === false ? '  offline' : ''}${driver}`);
    for (const ep of info.endpointList) {
      const value = ep.track
        ? `${ep.track.points} fixes${ep.track.lastAt ? `  ${ep.track.lastAt}` : ''}`
        : ep.last
        ? `${valueText(ep.last.value)}${ep.unit ? ` ${ep.unit}` : ''}  ${ep.last.at}`
        : '-';
      const notes = [ep.type === 'control' && ep.writable ? 'writable' : '', ep.supported ? '' : 'not read', ep.retired ? 'retired' : ''].filter(Boolean).join(', ');
      await cmd.writeLn(`  ${ep.name}  ${ep.type}  ${value}${notes ? `  (${notes})` : ''}`);
    }
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-show', error);
  }
};

deviceShow.spec = {
  name: 'device-show',
  effect: 'read' as const,
  description: "A device and each of its endpoints: a log's or control's latest value, a track's fixes, and whether you may write a control",
  args: [{ name: 'device', type: 'string' as const, description: `the device's name, or its path under ${DEV_PATH}` }],
  examples: ['device-show hall-plug', 'device-show /dev/ruby-phone'],
  returns: 'DeviceInfo',
};

/**
 * An endpoint's history: a log's or control's values, the latest `-n`, or those of a range; with
 * `--bucket`, summed up per interval. A track's fixes.
 */
export const deviceHistory = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['n', 'since', 'until', 'bucket', 'agg'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const target = parseTarget(String(flags._[0] ?? ''));
  if (!target?.endpoint) return await fail(cmd, 'device-history', 'usage: device-history <device>/<endpoint> [-n 100] [--since 24h] [--bucket 1h --agg avg]');
  try {
    const limit = flags.n === undefined ? 100 : Number(flags.n);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`-n takes a whole number above 0, not ${flags.n}`);
    const since = parseMoment(flags.since, '--since');
    const until = parseMoment(flags.until, '--until');
    const bucketMs = parseDuration(flags.bucket, '--bucket');
    if (bucketMs !== undefined && !(bucketMs >= 1000)) throw new Error(`--bucket takes a second or more, not ${flags.bucket}`);
    const aggregate = (flags.agg ?? 'avg') as HistoryAggregate;
    if (!AGGREGATES.includes(aggregate)) throw new Error(`--agg takes ${AGGREGATES.join(', ')}, not ${flags.agg}`);
    const history = await readHistory(cmd.sys.vfs, cmd.access, target.device, target.endpoint, {
      since,
      until,
      limit,
      ...(bucketMs !== undefined ? { bucket: { seconds: bucketMs / 1000, aggregate } } : {}),
    });
    if (cmd.json) {
      await cmd.writeJSON(history satisfies DeviceHistory);
      return 0;
    }
    if (history.fixes) {
      await cmd.write(history.fixes.map(({ at, ...fix }) => `${at}\t${JSON.stringify(fix)}\n`).join(''));
    } else {
      await cmd.write(
        history.readings.map((reading) =>
          `${reading.at}\t${JSON.stringify(reading.count === undefined ? { value: reading.value } : { value: reading.value, count: reading.count })}\n`
        ).join(''),
      );
    }
    return 0;
  } catch (error) {
    return await fail(cmd, 'device-history', error);
  }
};

deviceHistory.spec = {
  name: 'device-history',
  effect: 'read' as const,
  description: "An endpoint's history, oldest first: a log's or control's values, or with --bucket summed up per interval; a track's fixes",
  args: [{ name: 'endpoint', type: 'string' as const, description: '<device>/<endpoint>, or its path under /dev' }],
  flags: [
    { name: 'n', type: 'string' as const, description: 'at most this many values or intervals, the latest (100 when not given)' },
    { name: 'since', type: 'string' as const, description: 'from this time on: ISO 8601, or a duration such as 24h or 7d meaning that long ago' },
    { name: 'until', type: 'string' as const, description: 'before this time, as --since takes it' },
    { name: 'bucket', type: 'string' as const, description: 'sum the values up per interval of this length: 10m, 1h, 1d; a day is a calendar day' },
    { name: 'agg', type: 'string' as const, description: `with --bucket, how: ${AGGREGATES.join(', ')} (avg when not given); on and off count as 1 and 0` },
  ],
  examples: ['device-history hall-sensor/temperature -n 10', 'device-history hall-plug/power --since 7d --bucket 1h', 'device-history ruby-phone/position --since 1d'],
  returns: 'DeviceHistory',
};
