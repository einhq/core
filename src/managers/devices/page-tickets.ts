/**
 * Tickets that sign a browser in to show one page: a screen is shown a page (a dashboard wall, an
 * album's slideshow) by the media service, which opens it in a browser of its own that has no
 * account to sign in with. `GET /__page/<ticket>` opens a session for that browser with the access
 * the ticket was made with, read-only, as a share link's visitor reads, and sends it to the page.
 * A ticket opens one session, once, within `PAGE_TICKET_TTL_MS` of being made, and the session is
 * held until the page's stream ends it (`end`). Kept in memory.
 */

import type { Access } from '../../lib/access/types.ts';

/** How long a ticket waits for its browser. */
export const PAGE_TICKET_TTL_MS = 60_000;

/** What a ticket opens: the session's access and the page it starts on. */
export type PageTicket = { access: Access; route: string };

type Held = PageTicket & { expiresAt: number };

export class PageTickets {
  readonly #tickets = new Map<string, Held>();
  /** The tickets taken, with the session each opened once it has: until the page ends. */
  readonly #taken = new Map<string, string | undefined>();

  /** A new ticket that signs a browser in as `access`, read-only, and opens `route`. */
  issue(access: Access, route: string, now = Date.now()): string {
    this.#sweep(now);
    const ticket = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    this.#tickets.set(ticket, { access, route, expiresAt: now + PAGE_TICKET_TTL_MS });
    return ticket;
  }

  /** What `ticket` opens, once: undefined when it has run out or was taken before. */
  take(ticket: string, now = Date.now()): PageTicket | undefined {
    this.#sweep(now);
    const held = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!held) return undefined;
    this.#taken.set(ticket, undefined);
    return { access: held.access, route: held.route };
  }

  /** Hold `session`, the session the taken `ticket` opened, for `end`: false when its page ended first. */
  opened(ticket: string, session: string): boolean {
    if (!this.#taken.has(ticket)) return false;
    this.#taken.set(ticket, session);
    return true;
  }

  /** The page of `ticket` ended: the ticket no longer opens, and the session it opened, if any, for the caller to remove. */
  end(ticket: string): string | undefined {
    this.#tickets.delete(ticket);
    const session = this.#taken.get(ticket);
    this.#taken.delete(ticket);
    return session;
  }

  #sweep(now: number): void {
    for (const [ticket, held] of this.#tickets) {
      if (held.expiresAt <= now) this.#tickets.delete(ticket);
    }
  }
}
