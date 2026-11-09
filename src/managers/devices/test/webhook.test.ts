/** What the `webhook` driver reads from a request: a JSON object's, a form's and a query's fields. */

import { assertEquals } from '@std/assert';
import { readWebhook } from '../webhook.ts';

const read = (body: string, opts: { contentType?: string; query?: string } = {}) => readWebhook({ bytes: new TextEncoder().encode(body), ...opts });
const pairs = (body: string, opts: { contentType?: string; query?: string } = {}) => read(body, opts).readings.map((r) => [r.endpoint, r.value]);

Deno.test('webhook: a JSON object is a reading per field, nested ones named outer-inner', () => {
  assertEquals(pairs('{"temperature": 21.4, "door": "open", "ok": true, "bme280": {"Humidity %": 40}}', { contentType: 'application/json' }), [
    ['temperature', 21.4],
    ['door', 'open'],
    ['ok', true],
    ['bme280-humidity', 40],
  ]);
});

Deno.test("webhook: JSON's own types are kept, a form's and a query's text read as numbers and booleans", () => {
  assertEquals(pairs('{"serial": "0042", "level": "12"}'), [['serial', '0042'], ['level', '12']]);
  assertEquals(pairs('level=12&on=true&id=0042&state=open', { contentType: 'application/x-www-form-urlencoded' }), [
    ['level', 12],
    ['on', true],
    ['id', '0042'],
    ['state', 'open'],
  ]);
  assertEquals(pairs('', { query: 'battery=81&event=single' }), [['battery', 81], ['event', 'single']]);
});

Deno.test('webhook: a bare value or text is `value`, and an empty request a call', () => {
  assertEquals(pairs('21.4'), [['value', 21.4]]);
  assertEquals(pairs('door open\n'), [['value', 'door open']]);
  assertEquals(pairs(''), [['call', true]]);
});

Deno.test('webhook: ts, time or timestamp is when, and a list is several sets of readings', () => {
  const request = read('[{"ts": 1717236000, "t": 1}, {"time": "2024-06-01T10:05:00Z", "t": 2}, {"time": "noon", "t": 3}]');
  assertEquals(request.readings.map((r) => [r.endpoint, r.value, r.at?.toISOString()]), [
    ['t', 1, '2024-06-01T10:00:00.000Z'],
    ['t', 2, '2024-06-01T10:05:00.000Z'],
    ['time', 'noon', undefined],
    ['t', 3, undefined],
  ]);
});

Deno.test('webhook: a field with no name left or a list in it is not read, and says so', () => {
  const request = read('{"%%": 1, "samples": [1, 2], "ok": 1}');
  assertEquals([request.readings.map((r) => r.endpoint), request.skipped], [['ok'], ['%%', 'samples']]);
});
