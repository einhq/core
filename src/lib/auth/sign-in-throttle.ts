/**
 * How fast passwords may be tried. Every password check (`passwordSignIn`, `user-elevate`) begins
 * an attempt here, which counts as a failure from the moment it begins until it succeeds, so
 * attempts made in parallel count as soon as they are made. Failures are counted per client address
 * (an IPv6 address by its /64, which one client holds whole), per account and across all of them,
 * and forgotten an hour after the last one.
 *
 * An address past `FREE_FAILURES` is refused until its backoff has passed, without the password
 * being checked; the backoff doubles with each failure up to 15 minutes. An account past it is
 * slowed instead: each attempt at it begins no sooner than its backoff, at most
 * `ACCOUNT_DELAY_MAX_MS`, after the one before began, so attempts made in parallel wait their turn
 * rather than all waiting once. Across all accounts and addresses, attempts may come in a burst of
 * `GLOBAL_BURST` and then no faster than one every `GLOBAL_SPACING_MS`, so guessing from many
 * addresses at many accounts at once goes no faster either. An attempt that would wait longer than `QUEUE_MAX_MS` for its turn is
 * refused. None of that holds back an address that has signed in to the account within
 * `KNOWN_MS`, so guessing someone's password badly cannot lock its owner out where they signed in
 * before; only the address's own failures do.
 *
 * A failure is answered no sooner than `FAILURE_ANSWER_MS` after its check began, whatever the check
 * cost. A success forgets its account's failures, not its address's, so signing in to one's own
 * account does not buy more guesses at another's; at its address and across all it takes back what
 * its attempt counted, so the backoff runs from the last failure and a client that signs in again
 * straight after a success is not held back.
 */

import { createLogger } from '../../managers/logger/mod.ts';

const logger = createLogger('auth');

/** Failures an address or an account may have before it is held back. */
export const FREE_FAILURES = 5;
const ADDRESS_BACKOFF_MAX_MS = 15 * 60_000;
const ACCOUNT_DELAY_MAX_MS = 10_000;
/** Attempts across all accounts and addresses that may come at once, before they are spaced by `GLOBAL_SPACING_MS`. */
export const GLOBAL_BURST = 30;
const GLOBAL_SPACING_MS = 1000;
/** The longest an attempt waits for its turn; one that would wait longer is refused. */
const QUEUE_MAX_MS = 60_000;
const FORGET_MS = 60 * 60_000;
/** How long an address that signed in to an account is exempt from that account's and the global waits. */
const KNOWN_MS = 30 * 24 * 60 * 60_000;
/**
 * How long after its check begins a failed attempt is answered, at the earliest: longer than any
 * hash takes to verify, so a failure's time does not tell a hash at one cost from one at another,
 * or from the dummy that stands in for a missing account.
 */
const FAILURE_ANSWER_MS = 1000;
/** Addresses, accounts or known addresses kept, each; past it the expired go first, then the longest unseen. */
const MAX_ENTRIES = 10_000;

/**
 * `by` is the attempt that counted last, so a success can tell whether another has begun since;
 * `next` is when an account's next attempt may begin.
 */
type Count = { failures: number; last: number; by: number; next: number };

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

const refusal = (wait: number): Error => new Error(`too many failed sign-ins; try again in ${Math.ceil(wait / 1000)} s`);

/**
 * What the throttle counts an address as: an IPv4 address itself (an IPv4-mapped IPv6 one too),
 * an IPv6 address its /64, as `2001:db8:1:2::/64`. Anything else, such as `Forwarded`'s `unknown`,
 * is counted as it is.
 */
export function addressBucket(address: string): string {
  const bare = address.replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  const halves = bare.split('::');
  if (!bare.includes(':') || halves.length > 2) return bare;
  // An embedded IPv4 address at the end stands for two groups.
  const groups = (half: string | undefined): string[] => half ? half.split(':').flatMap((group) => group.includes('.') ? ['0', '0'] : [group]) : [];
  const [head, tail] = [groups(halves[0]), groups(halves[1])];
  const all = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  const prefix = all.slice(0, 4);
  if (all.length !== 8 || !prefix.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return bare;
  return `${prefix.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export class SignInThrottle {
  private readonly addresses = new Map<string, Count>();
  private readonly accounts = new Map<string, Count>();
  /** When each address last signed in to each account, by `account\naddress`. */
  private readonly known = new Map<string, number>();
  /** When the global burst is whole again: each attempt moves it on by `GLOBAL_SPACING_MS`. */
  private globalFull = 0;
  private attempts = 0;

  constructor(private readonly clock: ThrottleClock = realClock) {}

  /**
   * Begin an attempt at `account`'s password from `address` (undefined when the shell has none).
   * Throws when the address is held back, or when the attempt would wait too long for its turn;
   * waits for its turn otherwise.
   */
  async begin(account: string, address?: string): Promise<SignInAttempt> {
    const now = this.clock.now();
    const bucket = address === undefined ? undefined : addressBucket(address);
    const fromAddress = bucket === undefined ? undefined : this.current(this.addresses, bucket, now);
    if (fromAddress && fromAddress.failures >= FREE_FAILURES) {
      const wait = fromAddress.last + backoff(fromAddress.failures, ADDRESS_BACKOFF_MAX_MS) - now;
      if (wait > 0) throw refusal(wait);
    }
    const ofAccount = this.current(this.accounts, account, now);
    const knownAt = bucket === undefined ? undefined : this.known.get(`${account}\n${bucket}`);
    const known = knownAt !== undefined && now - knownAt <= KNOWN_MS;

    // Its turn: after the account's last attempt has had its backoff, and after the last one anywhere when many are failing.
    const globalFull = Math.max(this.globalFull, now) + GLOBAL_SPACING_MS;
    const globalStart = globalFull - GLOBAL_BURST * GLOBAL_SPACING_MS;
    let start = now;
    if (!known) {
      if (ofAccount.failures >= FREE_FAILURES) start = Math.max(start, ofAccount.next);
      start = Math.max(start, globalStart);
      if (start - now > QUEUE_MAX_MS) throw refusal(start - now - QUEUE_MAX_MS);
    }

    const attempt = ++this.attempts;
    const addressLast = fromAddress?.last;
    if (bucket !== undefined) this.fail(this.addresses, bucket, fromAddress!, now, attempt, { address: bucket });
    this.fail(this.accounts, account, ofAccount, now, attempt, { account });
    if (ofAccount.failures >= FREE_FAILURES) ofAccount.next = Math.max(ofAccount.next, start) + backoff(ofAccount.failures, ACCOUNT_DELAY_MAX_MS);
    // At the first attempt that has to wait for the global burst after one that did not.
    if (globalStart > now && this.globalFull - GLOBAL_BURST * GLOBAL_SPACING_MS <= now) logger.warn('many sign-ins across accounts');
    this.globalFull = globalFull;
    if (start > now) await this.clock.sleep(start - now);

    const checked = this.clock.now();
    let settled = false;
    return {
      failed: async () => {
        const wait = checked + FAILURE_ANSWER_MS - this.clock.now();
        if (wait > 0) await this.clock.sleep(wait);
      },
      succeeded: () => {
        if (settled) return;
        settled = true;
        this.accounts.delete(account);
        this.globalFull -= GLOBAL_SPACING_MS;
        if (bucket === undefined) return;
        this.remember(`${account}\n${bucket}`, this.clock.now());
        const count = this.addresses.get(bucket);
        if (count) this.takeBack(count, attempt, addressLast!);
      },
    };
  }

  /** The count kept for `key`, or a fresh one when there is none or it is forgotten. */
  private current(counts: Map<string, Count>, key: string, now: number): Count {
    const count = counts.get(key);
    return count && now - count.last <= FORGET_MS ? count : { failures: 0, last: now, by: 0, next: 0 };
  }

  /** Count `attempt` as a failure for `key`, keeping `counts` in order of last attempt and within `MAX_ENTRIES`. */
  private fail(counts: Map<string, Count>, key: string, count: Count, now: number, attempt: number, label: Record<string, string>): void {
    counts.delete(key);
    this.makeRoom(counts, now, (each) => each.last);
    this.count(count, now, attempt);
    counts.set(key, count);
    // At the first held-back failure, and then at each doubling, so a long run logs a few lines.
    const over = count.failures / FREE_FAILURES;
    if (Number.isInteger(over) && (over & (over - 1)) === 0) {
      logger.warn('repeated failed sign-ins', { ...label, failures: count.failures });
    }
  }

  private count(count: Count, now: number, attempt: number): void {
    count.failures += 1;
    count.last = now;
    count.by = attempt;
  }

  /** Take back the failure `attempt` counted; unless another has begun since, the last failure is the one before it. */
  private takeBack(count: Count, attempt: number, last: number): void {
    count.failures = Math.max(0, count.failures - 1);
    if (count.by === attempt) count.last = last;
  }

  /** Remember that `key`'s address signed in to its account at `now`. */
  private remember(key: string, now: number): void {
    this.known.delete(key);
    this.makeRoom(this.known, now, (at) => at, KNOWN_MS);
    this.known.set(key, now);
  }

  /** Below `MAX_ENTRIES` in `counts`: the forgotten go first, then the longest unseen. */
  private makeRoom<T>(counts: Map<string, T>, now: number, last: (each: T) => number, forget = FORGET_MS): void {
    if (counts.size < MAX_ENTRIES) return;
    for (const [key, each] of counts) if (now - last(each) > forget) counts.delete(key);
    while (counts.size >= MAX_ENTRIES) counts.delete(counts.keys().next().value!);
  }
}

/** The process's throttle: one per process, as the shells and the SSH server that sign in are. */
export const signInThrottle = new SignInThrottle();
