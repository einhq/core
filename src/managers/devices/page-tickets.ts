/**
 * Tickets that sign a browser in to show one page: a screen is shown a page (a dashboard wall, an
 * album's slideshow) by the media service, which opens it in a browser of its own that has no
 * account to sign in with. `GET /__page/<ticket>` opens a session for that browser with the access
 * the ticket was made with, read-only, as a share link's visitor reads, and sends it to the page.
 * A ticket opens one session, once, within `PAGE_TICKET_TTL_MS` of being made. Kept in memory.
 */

import type { Access } from '../../lib/access/types.ts';

/** How long a ticket waits for its browser. */
export const PAGE_TICKET_TTL_MS = 60_000;

/** What a ticket opens: the session's access and the page it starts on. */
export type PageTicket = { access: Access; route: string };

type Held = PageTicket & { expiresAt: number };

export class PageTickets {
  readonly #tickets = new Map<string, Held>();

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
    return held && { access: held.access, route: held.route };
  }

  #sweep(now: number): void {
    for (const [ticket, held] of this.#tickets) {
      if (held.expiresAt <= now) this.#tickets.delete(ticket);
    }
  }
}
