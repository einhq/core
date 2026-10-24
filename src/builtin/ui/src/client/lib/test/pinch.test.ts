import { assertEquals } from '@std/assert';
import { PHONE_COLUMNS_MAX, PHONE_COLUMNS_MIN, pinchStep, stepColumns } from '../pinch.ts';

Deno.test('spreading the fingers asks for fewer, closing them for more, a twitch for nothing', () => {
  assertEquals(pinchStep(100, 140), -1);
  assertEquals(pinchStep(100, 70), 1);
  assertEquals(pinchStep(100, 110), 0);
  assertEquals(pinchStep(0, 50), 0);
});

Deno.test('the column count stays within the phone range', () => {
  assertEquals(stepColumns(2, -1), PHONE_COLUMNS_MIN);
  assertEquals(stepColumns(2, 1), 3);
  assertEquals(stepColumns(PHONE_COLUMNS_MAX, 1), PHONE_COLUMNS_MAX);
});
