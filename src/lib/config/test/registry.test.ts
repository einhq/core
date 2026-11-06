/**
 * A module's settings: registered at its set-up, replaced by the next, never over another owner's,
 * and taken over by the module waiting for a key once its owner drops it.
 */

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
    unregisterConfigOptions('other');
  }
});

Deno.test('a setting moved to a module set up first is taken over when the old owner drops it', () => {
  try {
    registerConfigOptions('old', [option('CFG_EXAMPLE_SLOTS', '2'), option('CFG_EXAMPLE_KEPT', '1')]);
    assertEquals(registerConfigOptions('new', [option('CFG_EXAMPLE_SLOTS', '3')]), []);
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.owner, 'old');

    registerConfigOptions('old', [option('CFG_EXAMPLE_KEPT', '1')]);
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.owner, 'new');
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.default, '3');
  } finally {
    unregisterConfigOptions('old');
    unregisterConfigOptions('new');
  }
});

Deno.test('a module waiting for a setting keeps waiting while its owner is set up again with it', () => {
  try {
    registerConfigOptions('old', [option('CFG_EXAMPLE_SLOTS', '2'), option('CFG_EXAMPLE_KEPT', '1')]);
    registerConfigOptions('new', [option('CFG_EXAMPLE_SLOTS', '3')]);
    registerConfigOptions('old', [option('CFG_EXAMPLE_SLOTS', '2'), option('CFG_EXAMPLE_KEPT', '1')]);
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.owner, 'old');

    registerConfigOptions('old', [option('CFG_EXAMPLE_KEPT', '1')]);
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.owner, 'new');
  } finally {
    unregisterConfigOptions('old');
    unregisterConfigOptions('new');
  }
});

Deno.test('a removed module hands its settings to the module waiting for them, and waits for none', () => {
  try {
    registerConfigOptions('old', [option('CFG_EXAMPLE_SLOTS', '2')]);
    registerConfigOptions('new', [option('CFG_EXAMPLE_SLOTS', '3')]);
    unregisterConfigOptions('old');
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS')?.owner, 'new');

    registerConfigOptions('later', [option('CFG_EXAMPLE_SLOTS', '4')]);
    registerConfigOptions('later', []);
    unregisterConfigOptions('new');
    assertEquals(getConfigOption('CFG_EXAMPLE_SLOTS'), undefined);
  } finally {
    unregisterConfigOptions('old');
    unregisterConfigOptions('new');
  }
});
