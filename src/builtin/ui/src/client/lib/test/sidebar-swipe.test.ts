import { assertEquals } from '@std/assert';
import { sidebarSwipe } from '../sidebar-swipe.ts';

const at = (x: number, y: number, time = 0) => ({ x, y, time });

Deno.test('a sideways swipe says which way it went', () => {
  assertEquals(sidebarSwipe(at(100, 300), at(200, 320, 200)), 'right');
  assertEquals(sidebarSwipe(at(300, 300), at(180, 280, 200)), 'left');
});

Deno.test('a tap, a short twitch and a slow drag are not swipes', () => {
  assertEquals(sidebarSwipe(at(100, 300), at(100, 300, 80)), null);
  assertEquals(sidebarSwipe(at(100, 300), at(130, 300, 80)), null);
  assertEquals(sidebarSwipe(at(100, 300), at(250, 300, 1500)), null);
});

Deno.test('a scroll, even one arcing sideways, is not a swipe', () => {
  assertEquals(sidebarSwipe(at(200, 500), at(200, 100, 300)), null);
  assertEquals(sidebarSwipe(at(200, 500), at(280, 300, 300)), null);
  assertEquals(sidebarSwipe(at(100, 300), at(190, 360, 300)), null);
});
