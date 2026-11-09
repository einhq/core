import { assertEquals } from '@std/assert';
import { CORE_OPTIONS } from '../options.ts';
import { validateConfigValue } from '../validate.ts';

const option = CORE_OPTIONS.find((each) => each.key === 'CFG_USER_TIME_LOCALE')!;

Deno.test('config: a locale is a language tag Intl knows', () => {
  for (const value of ['en-SE', 'sv-SE', 'en-US', '']) assertEquals(validateConfigValue(option, value), undefined, value);
  for (const value of ['english', 'en_SE', '24h']) assertEquals(typeof validateConfigValue(option, value), 'string', value);
});
