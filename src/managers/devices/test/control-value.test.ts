/**
 * What a control takes, and when a reading is published: the small rules under every write to a
 * device, a switch's `toggle` included.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { ControlValueError, parseControlValue } from '../control-value.ts';
import { decide } from '../throttle.ts';
import { isGpx } from '../../../lib/track/gpx.ts';

Deno.test('a switch takes on, off and toggle, and toggle needs a state', () => {
  assertEquals(parseControlValue({ type: 'bool' }, 'on'), true);
  assertEquals(parseControlValue({ type: 'bool' }, ' OFF\n'), false);
  assertEquals(parseControlValue({ type: 'bool' }, 'toggle', true), false);
  assertThrows(() => parseControlValue({ type: 'bool' }, 'toggle'), ControlValueError, 'reported none');
  assertThrows(() => parseControlValue({ type: 'bool' }, '7'), ControlValueError, 'on, off or toggle');
});

Deno.test('a number keeps within its range and steps', () => {
  const setpoint = { type: 'number' as const, min: 5, max: 30, step: 0.5 };
  assertEquals(parseControlValue(setpoint, '21.5'), 21.5);
  assertThrows(() => parseControlValue(setpoint, '31'), ControlValueError, '30 or less');
  assertThrows(() => parseControlValue(setpoint, '21.3'), ControlValueError, 'steps of 0.5');
  assertThrows(() => parseControlValue(setpoint, 'warm'), ControlValueError, 'a number');
});

Deno.test('a choice, a line and a press', () => {
  assertEquals(parseControlValue({ type: 'enum', options: ['heat', 'cool', 'off'] }, 'cool'), 'cool');
  assertThrows(() => parseControlValue({ type: 'enum', options: ['heat', 'cool'] }, 'dry'), ControlValueError, 'heat, cool');
  assertEquals(parseControlValue({ type: 'text' }, 'hello'), 'hello');
  assertEquals(parseControlValue({ type: 'momentary' }, ''), 'press');
  assertThrows(() => parseControlValue({ type: 'momentary' }, 'on'), ControlValueError, 'press');
});

Deno.test('a reading is published when it changes, a number no oftener than its interval', () => {
  assertEquals(decide(undefined, 1, 0, 10_000), { publish: 'now' });
  assertEquals(decide({ value: 1, at: 0 }, 1, 50_000, 10_000), { publish: 'no' });
  assertEquals(decide({ value: 1, at: 0 }, 2, 4_000, 10_000), { publish: 'later', at: 10_000 });
  assertEquals(decide({ value: 1, at: 0 }, 2, 12_000, 10_000), { publish: 'now' });
  assertEquals(decide({ value: false, at: 0 }, true, 1, 10_000), { publish: 'now' });
});

Deno.test('a GPX document is known by its root, with or without a declaration', () => {
  assertEquals(isGpx('<?xml version="1.0"?>\n<gpx version="1.1">'), true);
  assertEquals(isGpx('  <gpx creator="x">'), true);
  assertEquals(isGpx('{"lat": 1}'), false);
  assertEquals(isGpx('anything', 'application/gpx+xml'), true);
});
