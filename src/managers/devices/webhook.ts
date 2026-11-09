/**
 * Core's `webhook` driver: a device or script that posts what it reads, in whatever shape a
 * webhook takes. Each field of a JSON object, a form or the query becomes a reading on the endpoint
 * of that name, a log made the first time it comes; `append` keeps it, throttled, and publishes it
 * on `dev.<device>.<endpoint>`, as any driver's readings are.
 *
 *   POST {"temperature": 21.4, "door": "open"}   → temperature 21.4, door "open"
 *   POST {"bme280": {"temperature": 21.4}}        → bme280-temperature 21.4
 *   GET  ?key=…&battery=81                         → battery 81
 *   POST 21.4 (a bare value, or a line of text)    → value 21.4
 *   GET  ?key=… (nothing else: a button's URL)     → call true, an event
 *
 * A field `ts`, `time` or `timestamp` that reads as a time (a date, or epoch seconds or
 * milliseconds) is when the readings were made, not a reading. A JSON array is a list of such
 * objects. The fields named in the device's `events` config are events: each one kept, the same
 * twice included, as a button's presses are.
 */

import type { DeviceValue } from '../../lib/api/devices.ts';
import { ADMIN_ACCESS } from '../../lib/access/constants.ts';
import type { Driver, DriverInput, ModuleDevices } from './types.ts';

/** One reading of a webhook: the endpoint it goes to, its value, and when it was made, if said. */
type WebhookReading = { endpoint: string; value: DeviceValue; at?: Date };

/** What a webhook said: its readings, and the fields that could not be one. */
type WebhookRequest = { readings: WebhookReading[]; skipped: string[] };

/** The endpoint a request with nothing in it is an event on, as a button calling its URL is. */
const WEBHOOK_CALL_ENDPOINT = 'call';

const TIME_FIELDS = new Set(['ts', 'time', 'timestamp']);

/** A number written as text, without leading zeros, so an id such as `0042` stays text. */
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;

/** A form's, query's or text's value as what it says: a number, `true` or `false`, or the text. */
const fromText = (text: string): DeviceValue => {
  const trimmed = text.trim();
  if (NUMBER_RE.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed;
};

/** A field's name as an endpoint's: lower-case letters, digits, - and _; empty when nothing is left. */
const endpointName = (field: string): string => field.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').replace(/-+$/, '').slice(0, 63);

/** A time a device gives: a date, or epoch seconds or milliseconds; undefined for one that does not read. */
const readTime = (raw: unknown): Date | undefined => {
  const value = typeof raw === 'string' && NUMBER_RE.test(raw.trim()) ? Number(raw) : raw;
  let at: Date | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) at = new Date(value < 1e12 ? value * 1000 : value);
  else if (typeof value === 'string' && value.trim() !== '') at = new Date(value);
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
};

type Fields = [string, unknown][];

/** The readings of a set of fields, nested objects named `<outer>-<inner>`, with their time. */
const readFields = (fields: Fields, out: WebhookRequest, fromForm: boolean): void => {
  let at: Date | undefined;
  const values: [string, DeviceValue][] = [];
  const walk = (prefix: string, entries: Fields) => {
    for (const [field, raw] of entries) {
      const name = prefix ? `${prefix}-${field}` : field;
      if (!prefix && TIME_FIELDS.has(field.toLowerCase())) {
        const time = readTime(raw);
        if (time) {
          at = time;
          continue;
        }
      }
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        walk(name, Object.entries(raw));
        continue;
      }
      const endpoint = endpointName(name);
      if (!endpoint || Array.isArray(raw) || raw === undefined) {
        out.skipped.push(name);
        continue;
      }
      values.push([endpoint, fromForm && typeof raw === 'string' ? fromText(raw) : raw as DeviceValue]);
    }
  };
  walk('', fields);
  for (const [endpoint, value] of values) out.readings.push({ endpoint, value, ...(at ? { at } : {}) });
};

/** The readings a webhook's request carries: its query's fields, then its body's. */
export function readWebhook(input: { bytes: Uint8Array; contentType?: string; query?: string }): WebhookRequest {
  const out: WebhookRequest = { readings: [], skipped: [] };
  const query = [...new URLSearchParams(input.query ?? '')];
  if (query.length > 0) readFields(query, out, true);

  const body = new TextDecoder().decode(input.bytes).trim();
  if (body !== '') {
    if ((input.contentType ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      readFields([...new URLSearchParams(body)], out, true);
    } else {
      let parsed: unknown;
      let isJson = true;
      try {
        parsed = JSON.parse(body);
      } catch {
        isJson = false;
      }
      if (!isJson) readFields([['value', body]], out, true);
      else {
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) readFields(Object.entries(item), out, false);
          else readFields([['value', item]], out, false);
        }
      }
    }
  }

  if (query.length === 0 && body === '') out.readings.push({ endpoint: WEBHOOK_CALL_ENDPOINT, value: true });
  return out;
}

/** The endpoints a device's `events` config names, split on commas and spaces. */
const eventEndpoints = (config: Record<string, string> | undefined): Set<string> => new Set((config?.events ?? '').split(/[\s,]+/).map(endpointName).filter(Boolean));

export const webhookDriver = (devices: ModuleDevices): Driver => ({
  description: 'A device or script posting what it reads: each field of a JSON object, a form or the query a reading',
  config: [{ name: 'events', label: 'Fields that are events, such as a button press, kept each time (comma-separated)', type: 'string' }],
  async input(raw: DriverInput) {
    const { readings, skipped } = readWebhook(raw);
    const events = eventEndpoints(raw.attrs.config);
    events.add(WEBHOOK_CALL_ENDPOINT);
    let taken = 0;
    for (const reading of readings) {
      const event = events.has(reading.endpoint);
      try {
        await devices.ensureEndpoint(ADMIN_ACCESS, raw.device, reading.endpoint, 'log', { label: reading.endpoint, ...(event ? { events: true } : {}) });
        if (await devices.append(ADMIN_ACCESS, raw.device, reading.endpoint, reading.value, reading.at ? { at: reading.at } : {})) taken++;
      } catch (error) {
        skipped.push(`${reading.endpoint} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const message = `${taken} of ${readings.length} readings new${skipped.length > 0 ? `; not read: ${skipped.join(', ')}` : ''}`;
    return { taken, message };
  },
});
