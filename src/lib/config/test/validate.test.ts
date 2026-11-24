import { assertEquals } from '@std/assert';
import { CORE_OPTIONS } from '../options.ts';
import { validateConfigValue } from '../validate.ts';

const option = CORE_OPTIONS.find((each) => each.key === 'CFG_USER_TIME_LOCALE')!;

Deno.test('config: a locale is a language tag Intl knows', () => {
  for (const value of ['en-SE', 'sv-SE', 'en-US', '']) assertEquals(validateConfigValue(option, value), undefined, value);
  for (const value of ['english', 'en_SE', '24h']) assertEquals(typeof validateConfigValue(option, value), 'string', value);
});

Deno.test('config: a position is a latitude, a longitude and a zoom a map can open at', () => {
  const position = CORE_OPTIONS.find((each) => each.key === 'CFG_MAP_CENTER')!;
  for (const value of ['51.5074, -0.1278, 11', '-33.9,151.2,2', '0, 0, 18', position.default]) assertEquals(validateConfigValue(position, value), undefined, value);
  for (const value of ['', '51.5, -0.1', '91, 0, 10', '51.5, 181, 10', '51.5, -0.1, 1', '51.5, -0.1, 12.5', 'London']) {
    assertEquals(typeof validateConfigValue(position, value), 'string', value);
  }
  const personal = CORE_OPTIONS.find((each) => each.key === 'CFG_USER_MAP_CENTER')!;
  assertEquals(validateConfigValue(personal, ''), undefined);
});
