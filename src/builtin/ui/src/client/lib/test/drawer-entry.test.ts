import { assertEquals } from '@std/assert';
import { drawerOfEntry, withDrawerEntry } from '../drawer-entry.ts';

Deno.test('drawer entry: the route round-trips through an entry, keeping the page state beside it', () => {
  const state = withDrawerEntry({ fullscreenPushed: true }, '/chat');
  assertEquals(drawerOfEntry(state), '/chat');
  assertEquals(state.fullscreenPushed, true);
  assertEquals(drawerOfEntry(withDrawerEntry(state, '/notes')), '/notes');
});

Deno.test('drawer entry: an entry without the drawer has none', () => {
  for (const state of [null, undefined, 'page', {}, { drawer: 3 }]) assertEquals(drawerOfEntry(state), null);
  assertEquals(drawerOfEntry(withDrawerEntry(null, '/chat')), '/chat');
});
