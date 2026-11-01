/** A module's settings: registered at its set-up, replaced by the next, never over another owner's. */

import { assertEquals } from '@std/assert';
import type { ConfigOption } from '../types.ts';
import { getConfigOption, registerConfigOptions, unregisterConfigOptions } from '../registry.ts';

const option = (key: string, defaultValue: string): ConfigOption => ({
  key,
  scope: 'system',
  type: 'number',
  default: defaultValue,
  label: 'Example',
  description: '',
  group: 'Example',
});

Deno.test('a module set up again replaces its settings and drops the ones it no longer declares', () => {
  try {
    registerConfigOptions('example', [option('CFG_EXAMPLE_LIMIT', '0.5'), option('CFG_EXAMPLE_OLD', '1')]);
    assertEquals(registerConfigOptions('example', [option('CFG_EXAMPLE_LIMIT', '0.51')]), ['CFG_EXAMPLE_LIMIT']);
    assertEquals(getConfigOption('CFG_EXAMPLE_LIMIT')?.default, '0.51');
    assertEquals(getConfigOption('CFG_EXAMPLE_OLD'), undefined);
  } finally {
    unregisterConfigOptions('example');
  }
});

Deno.test("a module never takes another module's setting", () => {
  try {
    registerConfigOptions('example', [option('CFG_EXAMPLE_LIMIT', '0.5')]);
    assertEquals(registerConfigOptions('other', [option('CFG_EXAMPLE_LIMIT', '9')]), []);
    assertEquals(getConfigOption('CFG_EXAMPLE_LIMIT')?.owner, 'example');
    assertEquals(getConfigOption('CFG_EXAMPLE_LIMIT')?.default, '0.5');
  } finally {
    unregisterConfigOptions('example');
  }
});
