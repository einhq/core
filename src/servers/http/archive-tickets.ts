import { NodePath } from '../../vfs/mod.ts';
import { numberedName } from './numbered-name.ts';

/**
 * Short-lived tickets for `GET /archive/<token>`.
 *
 * A bulk download is a list of paths, which is too much to carry in a URL — a hundred
 * selected photos is well past what a browser will send as a query string — and the
 * download itself has to be a plain navigation, so it cannot be a POST. So the selection is
 * posted once, parked here under a random token, and fetched back by the navigation that
 * downloads it.
 *
 * The token is not a capability: `get-archive` opens every file with the access of the
 * session presenting it, so a leaked token grants nothing its holder could not already
 * fetch one file at a time. It only names a list, which is why it can expire quickly.
 */

/**
 * How long a posted selection stays fetchable.
 *
 * This spans one user gesture — the UI navigates to the URL as soon as the POST answers —
 * so it is generous rather than tuned. It bounds the *start* of the download, not its
 * length: a transfer already streaming is unaffected by its ticket expiring underneath it.
 */
export const ARCHIVE_TICKET_TTL_MS = 5 * 60 * 1000;

/** Refused above this, so one POST cannot park an unbounded list in memory. */
export const ARCHIVE_MAX_ENTRIES = 5000;

export type ArchiveEntry = {
  /** The VFS path to read at download time. */
  path: NodePath;
  /** Where it lands inside the archive, unique across the ticket. */
  name: string;
  /** `props.modtime`, so the extracted file keeps a plausible date. */
  modified: number;
};

export type ArchiveTicket = {
  entries: ArchiveEntry[];
  /** The name the browser saves the archive under. */
  filename: string;
  expiresAt: number;
};

export class ArchiveTicketStore {
  readonly #tickets = new Map<string, ArchiveTicket>();

  /** Park a selection and return the token naming it. */
  issue(entries: ArchiveEntry[], filename: string, now = Date.now()): { token: string; ticket: ArchiveTicket } {
    this.#sweep(now);

    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const ticket: ArchiveTicket = { entries, filename, expiresAt: now + ARCHIVE_TICKET_TTL_MS };
    this.#tickets.set(token, ticket);

    return { token, ticket };
  }

  /**
   * The ticket a token names, or undefined once it has expired.
   *
   * Deliberately not single-use: a download that dies on the network is retried by the
   * browser against the same URL, and a ticket consumed by the first attempt would turn a
   * dropped connection into a dead link.
   */
  get(token: string, now = Date.now()): ArchiveTicket | undefined {
    this.#sweep(now);
    return this.#tickets.get(token);
  }

  /**
   * Drop what has expired.
   *
   * Swept on every access rather than on a timer: a timer would be a resource the test
   * harness has to shut down, and there is nothing to collect between requests anyway.
   */
  #sweep(now: number): void {
    for (const [token, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) {
        this.#tickets.delete(token);
      }
    }
  }
}

/**
 * A zip entry name for `base` that no earlier entry in `used` took.
 *
 * Selections cross albums, so `IMG_0042.jpg` twice is ordinary rather than exceptional, and
 * a zip with two identical names extracts as one file: the second silently overwrites the
 * first, or the tool refuses the archive.
 */
export function uniqueEntryName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let n = 2;; n++) {
    const candidate = numberedName(base, n);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
