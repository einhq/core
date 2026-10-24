import { assertEquals } from '@std/assert';
import { createScrollVelocityGate } from '../scroll-velocity.ts';

Deno.test('scroll velocity: slow browsing keeps media windows live', () => {
  const gate = createScrollVelocityGate();
  assertEquals(gate.sample(0, 0), false);
  assertEquals(gate.sample(6, 16), false);
  assertEquals(gate.sample(13, 32), false);
});

Deno.test('scroll velocity: a fast fling defers media windows', () => {
  const gate = createScrollVelocityGate();
  gate.sample(0, 0);
  assertEquals(gate.sample(24, 16), true);
  assertEquals(gate.sample(50, 32), true);
});

Deno.test('scroll velocity: slowing down resumes before scrolling stops', () => {
  const gate = createScrollVelocityGate();
  gate.sample(0, 0);
  assertEquals(gate.sample(24, 16), true);
  assertEquals(gate.sample(28, 32), true);
  assertEquals(gate.sample(32, 48), false);
});

Deno.test('scroll velocity: a pause starts a fresh gesture', () => {
  const gate = createScrollVelocityGate();
  gate.sample(0, 0);
  assertEquals(gate.sample(24, 16), true);
  assertEquals(gate.sample(200, 250), false);
});
