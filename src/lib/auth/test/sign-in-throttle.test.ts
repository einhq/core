/**
 * `SignInThrottle`: an address past a few failures is refused for a growing backoff, an account
 * past them is slowed, attempts made in parallel count at once and wait their turn, and an address
 * that signed in to an account before is not held back by others' guesses at it.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { addressBucket, FREE_FAILURES, GLOBAL_BURST, SignInThrottle, type ThrottleClock } from '../sign-in-throttle.ts';

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

  await t.step('an account is slowed past its free failures, each attempt waiting its backoff after the one before', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    // Each guess from another address, so only the account counts.
    for (let i = 0; i < FREE_FAILURES + 6; i++) {
      const slept = clock.slept.length;
      await throttle.begin('anna', `192.0.2.${i}`);
      clock.advance(clock.slept.slice(slept).reduce((sum, ms) => sum + ms, 0));
    }
    assertEquals(clock.slept, [1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  await t.step('attempts at an account in parallel wait their turn, and are refused past a minute', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    await Promise.all(Array.from({ length: FREE_FAILURES + 6 }, (_, i) => throttle.begin('anna', `192.0.2.${i}`)));
    assertEquals(clock.slept, [1000, 3000, 7000, 15_000, 25_000, 35_000]);
    await throttle.begin('anna', '192.0.2.100');
    await throttle.begin('anna', '192.0.2.101');
    await assertRejects(() => throttle.begin('anna', '192.0.2.102'), Error, 'too many failed sign-ins; try again in 5 s');
  });

  await t.step('an address that signed in to an account is not held back by guesses at it', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    (await throttle.begin('anna', '198.51.100.1')).succeeded();
    for (let i = 0; i < FREE_FAILURES + 8; i++) await throttle.begin('anna', `192.0.2.${i}`);
    await assertRejects(() => throttle.begin('anna', '192.0.2.200'), Error, 'too many failed sign-ins');
    const slept = clock.slept.length;
    (await throttle.begin('anna', '198.51.100.1')).succeeded();
    assertEquals(clock.slept.length, slept);
    // Its own failures still hold it back.
    await fail(throttle, FREE_FAILURES, 'anna', '198.51.100.1');
    await assertRejects(() => throttle.begin('anna', '198.51.100.1'), Error, 'try again in 1 s');
  });

  await t.step('across all accounts, attempts past a burst wait their turn', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    // Each at another account from another address, so neither holds them back.
    await Promise.all(Array.from({ length: GLOBAL_BURST + 3 }, (_, i) => throttle.begin(`name-${i}`, `192.0.2.${i}`)));
    assertEquals(clock.slept, [1000, 2000, 3000]);
    // A success gives its place back.
    clock.advance(3000);
    (await throttle.begin('anna', '198.51.100.1')).succeeded();
    assertEquals(clock.slept, [1000, 2000, 3000, 1000]);
    await throttle.begin('bo', '198.51.100.2');
    assertEquals(clock.slept, [1000, 2000, 3000, 1000, 1000]);
  });

  await t.step('an IPv6 client is counted by its /64', async () => {
    const throttle = new SignInThrottle(fakeClock());
    for (let i = 0; i < FREE_FAILURES; i++) await throttle.begin(`name-${i}`, `2001:db8:1:2::${i + 1}`);
    await assertRejects(() => throttle.begin('anna', '2001:db8:1:2:ffff:ffff:ffff:ffff'), Error, 'try again in 1 s');
    await throttle.begin('anna', '2001:db8:1:3::1');
  });

  await t.step('a success forgets its account’s failures, and is not counted against its address', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    await fail(throttle, FREE_FAILURES, 'anna', '192.0.2.1');
    clock.advance(1000);
    (await throttle.begin('anna', '192.0.2.1')).succeeded();
    assertEquals(clock.slept, []);

    // The address's failures stand: one more is the sixth, whose backoff is two seconds.
    clock.advance(1000);
    await throttle.begin('bo', '192.0.2.1');
    await assertRejects(() => throttle.begin('bo', '192.0.2.1'), Error, 'try again in 2 s');
    // The account's are gone.
    await throttle.begin('anna', '192.0.2.9');
    assertEquals(clock.slept, []);
  });

  await t.step('an address held back may sign in again and again once its backoff has passed', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    for (let i = 0; i < FREE_FAILURES + 7; i++) {
      clock.advance(128_000);
      await throttle.begin(`name-${i}`, '192.0.2.1');
    }
    clock.advance(128_000);
    for (let i = 0; i < 3; i++) (await throttle.begin('anna', '192.0.2.1')).succeeded();
    // The next failure is still the thirteenth, its backoff counted from it.
    await throttle.begin('bo', '192.0.2.1');
    await assertRejects(() => throttle.begin('anna', '192.0.2.1'), Error, 'try again in 256 s');
  });

  await t.step('a success leaves an attempt begun after it counted from when that began', async () => {
    const clock = fakeClock();
    const throttle = new SignInThrottle(clock);
    await fail(throttle, FREE_FAILURES - 1, 'name', '192.0.2.1');
    clock.advance(1000);
    const right = await throttle.begin('anna', '192.0.2.1');
    clock.advance(1000);
    await throttle.begin('bo', '192.0.2.1');
    right.succeeded();
    clock.advance(500);
    await assertRejects(() => throttle.begin('bo', '192.0.2.1'), Error, 'try again in 1 s');
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

Deno.test('addressBucket', () => {
  assertEquals(addressBucket('192.0.2.7'), '192.0.2.7');
  assertEquals(addressBucket('::ffff:192.0.2.7'), '192.0.2.7');
  assertEquals(addressBucket('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assertEquals(addressBucket('2001:0DB8:0001:0002::1'), '2001:db8:1:2::/64');
  assertEquals(addressBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assertEquals(addressBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assertEquals(addressBucket('::1'), '0:0:0:0::/64');
  assertEquals(addressBucket('64:ff9b::192.0.2.7'), '64:ff9b:0:0::/64');
  assertEquals(addressBucket('unknown'), 'unknown');
  assertEquals(addressBucket('not:an:address'), 'not:an:address');
});
