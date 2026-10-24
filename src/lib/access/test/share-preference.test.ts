import { assertEquals } from '@std/assert';
import { applySharePreference } from '../share-preference.ts';

Deno.test('applySharePreference narrows the system default and never the owner', () => {
  assertEquals(applySharePreference(0o755, 'private'), 0o700);
  assertEquals(applySharePreference(0o700, 'shared'), 0o750);
  assertEquals(applySharePreference(0o775, 'shared'), 0o770);
  // Every account reads it through the users group's grant, never through the other bits.
  assertEquals(applySharePreference(0o755, 'everyone'), 0o750);
  // Unset and "default" follow the system setting untouched.
  assertEquals(applySharePreference(0o751), 0o751);
  assertEquals(applySharePreference(0o751, 'default'), 0o751);
  // A default that already withholds owner bits keeps withholding them: only group/other change.
  assertEquals(applySharePreference(0o500, 'private'), 0o500);
});
