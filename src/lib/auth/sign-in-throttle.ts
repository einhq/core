/**
 * How fast passwords may be tried. Every password check (`passwordSignIn`, `user-elevate`) begins
 * an attempt here, which counts as a failure from the moment it begins until it succeeds, so
 * attempts made in parallel count as soon as they are made. Failures are counted per client address
 * and per account, and forgotten an hour after the last one.
 *
 * An address past `FREE_FAILURES` is refused until its backoff has passed, without the password
 * being checked; the backoff doubles with each failure up to 15 minutes. An account past it is only
 * slowed, by at most `ACCOUNT_DELAY_MAX_MS` per attempt and never refused, so guessing someone's
 * password badly cannot lock them out. A failure is answered no sooner than `FAILURE_ANSWER_MS` after
 * its check began, whatever the check cost. A success forgets its account's failures, not its address's,
 * so signing in to one's own account does not buy more guesses at another's.
 */

import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('auth');

/** Failures an address or an account may have before it is held back. */
export const FREE_FAILURES = 5;
const ADDRESS_BACKOFF_MAX_MS = 15 * 60_000;
const ACCOUNT_DELAY_MAX_MS = 10_000;
const FORGET_MS = 60 * 60_000;
/**
 * How long after its check begins a failed attempt is answered, at the earliest: longer than any
 * hash takes to verify, so a failure's time does not tell a hash at one cost from one at another,
 * or from the dummy that stands in for a missing account.
 */
const FAILURE_ANSWER_MS = 1000;
/** Addresses or accounts kept, each; past it the expired go first, then the longest unseen. */
const MAX_ENTRIES = 10_000;

type Count = { failures: number; last: number };

/** The time and the waiting a throttle uses: real ones, or a test's. */
export type ThrottleClock = { now(): number; sleep(ms: number): Promise<void> };

const realClock: ThrottleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A begun attempt: tell the throttle when it turns out to be right. A failure is already counted;
 * `failed` waits out `FAILURE_ANSWER_MS` from the check's start before it is answered.
 */
type SignInAttempt = { succeeded(): void; failed(): Promise<void> };

/** Doubling from a second at `FREE_FAILURES`, to `max`. */
const backoff = (failures: number, max: number): number => Math.min(1000 * 2 ** (failures - FREE_FAILURES), max);

export class SignInThrottle {
  private readonly addresses = new Map<string, Count>();
  private readonly accounts = new Map<string, Count>();

  constructor(private readonly clock: ThrottleClock = realClock) {}

  /**
   * Begin an attempt at `account`'s password from `address` (undefined when the shell has none).
   * Throws when the address is held back; waits when the account is.
   */
  async begin(account: string, address?: string): Promise<SignInAttempt> {
    const now = this.clock.now();
    const fromAddress = address === undefined ? undefined : this.current(this.addresses, address, now);
    if (fromAddress && fromAddress.failures >= FREE_FAILURES) {
      const wait = fromAddress.last + backoff(fromAddress.failures, ADDRESS_BACKOFF_MAX_MS) - now;
      if (wait > 0) throw new Error(`too many failed sign-ins; try again in ${Math.ceil(wait / 1000)} s`);
    }
    const ofAccount = this.current(this.accounts, account, now);
    const delay = ofAccount.failures >= FREE_FAILURES ? backoff(ofAccount.failures, ACCOUNT_DELAY_MAX_MS) : 0;

    if (address !== undefined) this.fail(this.addresses, address, fromAddress!, now, { address });
    this.fail(this.accounts, account, ofAccount, now, { account });
    if (delay > 0) await this.clock.sleep(delay);

    const start = this.clock.now();
    let settled = false;
    return {
      failed: async () => {
        const wait = start + FAILURE_ANSWER_MS - this.clock.now();
        if (wait > 0) await this.clock.sleep(wait);
      },
      succeeded: () => {
        if (settled) return;
        settled = true;
        this.accounts.delete(account);
        const count = address === undefined ? undefined : this.addresses.get(address);
        if (count) count.failures = Math.max(0, count.failures - 1);
      },
    };
  }

  /** The count kept for `key`, or a fresh one when there is none or it is forgotten. */
  private current(counts: Map<string, Count>, key: string, now: number): Count {
    const count = counts.get(key);
    return count && now - count.last <= FORGET_MS ? count : { failures: 0, last: now };
  }

  /** Count a failure for `key`, keeping `counts` in order of last failure and within `MAX_ENTRIES`. */
  private fail(counts: Map<string, Count>, key: string, count: Count, now: number, label: Record<string, string>): void {
    counts.delete(key);
    if (counts.size >= MAX_ENTRIES) {
      for (const [other, each] of counts) if (now - each.last > FORGET_MS) counts.delete(other);
      while (counts.size >= MAX_ENTRIES) counts.delete(counts.keys().next().value!);
    }
    count.failures += 1;
    count.last = now;
    counts.set(key, count);
    // At the first held-back failure, and then at each doubling, so a long run logs a few lines.
    const over = count.failures / FREE_FAILURES;
    if (Number.isInteger(over) && (over & (over - 1)) === 0) {
      logger.warn('repeated failed sign-ins', { ...label, failures: count.failures });
    }
  }
}

/** The process's throttle: one per process, as the shells and the SSH server that sign in are. */
export const signInThrottle = new SignInThrottle();
