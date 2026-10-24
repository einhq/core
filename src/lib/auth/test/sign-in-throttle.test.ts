/**
 * `SignInThrottle`: an address past a few failures is refused for a growing backoff, an account
 * past them is slowed and never refused, and attempts made in parallel count at once.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { FREE_FAILURES, SignInThrottle, type ThrottleClock } from '../sign-in-throttle.ts';

/** A clock that moves only when told to, and records what it was asked to wait. */
function fakeClock(): ThrottleClock & { advance(ms: number): void; slept: number[] } {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
    slept,
  };
}

/** `count` failed attempts at `account` from `address`. */
async function fail(throttle: SignInThrottle, count: number, account: string, address?: string): Promise<void> {
  for (let i = 0; i < count; i++) await throttle.begin(account, address);
}

Deno.test('SignInThrottle', async (t) => {
  await t.step('an address is refused past its free failures, for a backoff that doubles', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    // Each guess at another name, so only the address counts.
    for (let i = 0; i < FREE_FAILURES; i++) await throttle.begin(`name-${i}`, '192.0.2.1');
    await assertRejects(() => throttle.begin('anna', '192.0.2.1'), Error, 'too many failed sign-ins; try again in 1 s');
    // Another address is not held back.
    await throttle.begin('anna', '192.0.2.2');

    clock.advance(1000);
    await throttle.begin('anna', '192.0.2.1');
    await assertRejects(() => throttle.begin('anna', '192.0.2.1'), Error, 'try again in 2 s');
    clock.advance(2000);
    await throttle.begin('anna', '192.0.2.1');
    await assertRejects(() => throttle.begin('anna', '192.0.2.1'), Error, 'try again in 4 s');
  });

  await t.step('the backoff stops at 15 minutes, and an hour without failures forgets them', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    for (let i = 0; i < FREE_FAILURES + 20; i++) {
      await throttle.begin(`name-${i}`, '192.0.2.1');
      clock.advance(15 * 60_000);
    }
    clock.advance(-1000);
    await assertRejects(() => throttle.begin('anna', '192.0.2.1'), Error, 'try again in 1 s');

    clock.advance(60 * 60_000);
    await fail(throttle, FREE_FAILURES, 'anna', '192.0.2.1');
  });

  await t.step('an account is slowed past its free failures, never refused', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    // Each guess from another address, so only the account counts.
    for (let i = 0; i < FREE_FAILURES + 6; i++) await throttle.begin('anna', `192.0.2.${i}`);
    assertEquals(clock.slept, [1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  await t.step('a success forgets its account’s failures, and is not counted against its address', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    await fail(throttle, FREE_FAILURES, 'anna', '192.0.2.1');
    clock.advance(1000);
    (await throttle.begin('anna', '192.0.2.1')).succeeded();
    assertEquals(clock.slept, [1000]);

    // The address's failures stand: one more is the sixth, whose backoff is two seconds.
    clock.advance(1000);
    await throttle.begin('bo', '192.0.2.1');
    await assertRejects(() => throttle.begin('bo', '192.0.2.1'), Error, 'try again in 2 s');
    // The account's are gone.
    await throttle.begin('anna', '192.0.2.9');
    assertEquals(clock.slept, [1000]);
  });

  await t.step('attempts in flight count as failures', async () => {
    const throttle = new SignInThrottle(fakeClock());
    const begun = await Promise.allSettled(Array.from({ length: FREE_FAILURES + 3 }, (_, i) => throttle.begin(`name-${i}`, '192.0.2.1')));
    assertEquals(begun.filter((each) => each.status === 'fulfilled').length, FREE_FAILURES);
  });

  await t.step('a failure is answered a second after its check began, however long the check took', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    const quick = await throttle.begin('anna', '192.0.2.1');
    clock.advance(150);
    await quick.failed();
    const slow = await throttle.begin('bo', '192.0.2.1');
    clock.advance(1200);
    await slow.failed();
    assertEquals(clock.slept, [850]);
  });

  await t.step('without an address only the account counts', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    await fail(throttle, FREE_FAILURES + 1, 'anna');
    assertEquals(clock.slept, [1000]);
  });
});
