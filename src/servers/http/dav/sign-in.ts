/**
 * WebDAV's sign-in: HTTP Basic, an account's username or e-mail address and its password, checked
 * as every password sign-in is (`passwordSignIn`: the throttle, one hash, the same failures) and
 * written to the access log `via dav`.
 *
 * A WebDAV client sends the password with every request, and one check costs a scrypt hash, so a
 * pair that passed is kept for an hour under a keyed hash of it, never as it was sent. Each request
 * that finds it reads the account and its password's hash again, so a password set, an account
 * disabled or one deleted counts from the next request; only the account's groups wait for the hour.
 */

import { encodeHex } from '@std/encoding/hex';
import { decodeBase64 } from '@std/encoding';
import { join } from '@std/path';
import { ulid } from '@std/ulid';
import { type Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { accountPasswordHash, passwordSignIn, SignInFailedError } from '../../../lib/auth/account-password.ts';
import { userAccess } from '../../../lib/auth/member-gids.ts';
import { addressBucket } from '../../../lib/auth/sign-in-throttle.ts';
import { homePath, USERS_PATH } from '../../../lib/paths.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { type NodeVFS, recordAccess } from '../../../vfs/mod.ts';
import { isUserNode, loginRefusal } from '../../../vfs/types/user.ts';

const logger = createLogger('dav-sign-in');

/** How long a verified pair is kept before its password is hashed again. */
const VERIFIED_FOR_MS = 60 * 60_000;

/** Verified pairs, and addresses whose last failure was logged, kept at most; past it the oldest go. */
const MAX_KEPT = 1_000;

/**
 * How long after one failed sign-in is logged the next from the same address (an IPv6 address by
 * its /64, as the throttle counts it), at the same account and for the same reason are not: a
 * client retries a refused request at once, and past five failures the throttle refuses without
 * hashing, so the requests come as fast as the client sends them.
 */
const FAILURE_LOG_MS = 60_000;

/** The challenge a request without a usable sign-in is answered with. */
const CHALLENGE = 'Basic realm="EiN", charset="UTF-8"';

/** Who a WebDAV request acts as. */
export type DavUser = { username: string; home: string; access: Access };

type Verified = { username: string; uid: number; passwordHash: string; access: Access; at: number };

/** `Authorization: Basic …` as the login and password it carries; undefined when it carries none. */
function basicCredentials(header: string | null): { login: string; password: string } | undefined {
  const match = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!match) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(match[1]);
  } catch {
    return undefined;
  }
  // RFC 7617 asks for UTF-8 where the challenge says so; some clients send ISO-8859-1 regardless.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('latin1').decode(bytes);
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return undefined;
  return { login: text.slice(0, colon), password: text.slice(colon + 1) };
}

/** The answer to a request that has not signed in, or failed to. */
const unauthorized = (message: string): Response =>
  new Response(`${message}\n`, { status: 401, headers: { 'WWW-Authenticate': CHALLENGE, 'Content-Type': 'text/plain; charset=utf-8' } });

/**
 * The sign-ins of one server's WebDAV requests. Per server rather than module-level, as the
 * download log is: the test harness starts several in one process.
 */
export class DavSignIns {
  readonly #key = crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  readonly #verified = new Map<string, Verified>();
  readonly #checking = new Map<string, Promise<Verified | SignInFailedError>>();
  readonly #failuresLogged = new Map<string, number>();

  constructor(
    private readonly vfs: NodeVFS,
    private readonly env: Record<string, string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Who `headers` sign in as, or the 401 to answer them with. */
  async signIn(headers: Headers, from: string | undefined): Promise<DavUser | Response> {
    const credentials = basicCredentials(headers.get('authorization'));
    if (!credentials) return unauthorized('sign in with your username and password');

    const key = await this.#keyOf(credentials.login, credentials.password);
    const kept = this.#verified.get(key);
    if (kept && this.now() - kept.at < VERIFIED_FOR_MS && await this.#stillHolds(kept)) {
      return { username: kept.username, home: homePath(kept.username), access: kept.access };
    }
    this.#verified.delete(key);

    let checking = this.#checking.get(key);
    if (!checking) {
      checking = this.#check(credentials.login, credentials.password, from).finally(() => this.#checking.delete(key));
      this.#checking.set(key, checking);
    }
    const outcome = await checking;
    if (outcome instanceof SignInFailedError) return unauthorized(outcome.message);

    if (!this.#verified.has(key)) {
      if (this.#verified.size >= MAX_KEPT) this.#verified.delete(this.#verified.keys().next().value!);
      this.#verified.set(key, outcome);
    }
    return { username: outcome.username, home: homePath(outcome.username), access: outcome.access };
  }

  async #keyOf(login: string, password: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', await this.#key, new TextEncoder().encode(`${login}\0${password}`));
    return encodeHex(new Uint8Array(mac));
  }

  /** Whether the account a kept pair signed in as may still: there, the same uid, allowed, the same password. */
  async #stillHolds(kept: Verified): Promise<boolean> {
    const userPath = join(USERS_PATH, kept.username);
    const userNode = await this.vfs.get(ADMIN_ACCESS, userPath).catch(() => undefined);
    if (!userNode || !isUserNode(userNode) || userNode.attrs.uid !== kept.uid || loginRefusal(userNode.attrs)) return false;
    return await accountPasswordHash(this.vfs, userPath) === kept.passwordHash;
  }

  /** One password check, shared by the requests that arrive with the same pair while it runs. */
  async #check(login: string, password: string, from: string | undefined): Promise<Verified | SignInFailedError> {
    try {
      const account = await passwordSignIn(this.vfs, login, password, { env: this.env, from });
      const access = { ...await userAccess(this.vfs, ADMIN_ACCESS, account.username, account.userNode), sid: `dav-${ulid()}` };
      await recordAccess(this.vfs, { event: 'sign-in', uid: access.uid, sid: access.sid, from, via: 'dav', method: 'password' });
      return { username: account.username, uid: access.uid, passwordHash: account.passwordHash, access, at: this.now() };
    } catch (error) {
      if (!(error instanceof SignInFailedError)) throw error;
      logger.debug('WebDAV sign-in failed', { login, from, error: error.message });
      await this.#logFailure(error, from);
      return error;
    }
  }

  async #logFailure(error: SignInFailedError, from: string | undefined): Promise<void> {
    const now = this.now();
    // The throttle's wait is in its message; without the number one reason stays one.
    const key = `${from === undefined ? '' : addressBucket(from)}\0${error.uid ?? ''}\0${error.message.replace(/\d+/g, '#')}`;
    const last = this.#failuresLogged.get(key);
    if (last !== undefined && now - last < FAILURE_LOG_MS) return;
    if (this.#failuresLogged.size >= MAX_KEPT) {
      for (const [other, at] of this.#failuresLogged) if (now - at >= FAILURE_LOG_MS) this.#failuresLogged.delete(other);
      while (this.#failuresLogged.size >= MAX_KEPT) this.#failuresLogged.delete(this.#failuresLogged.keys().next().value!);
    }
    this.#failuresLogged.set(key, now);
    await recordAccess(this.vfs, { event: 'sign-in-failed', uid: error.uid, reason: error.message, from, via: 'dav', method: 'password' });
  }
}
