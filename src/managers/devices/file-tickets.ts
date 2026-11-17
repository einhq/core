/**
 * Tickets for a device on the network to read one file with: a speaker or a screen fetches what it
 * was given to play itself, and has no session to sign in with. A ticket names one path and the
 * access of whoever gave the device something to play; `/file<path>?ticket=<ticket>` reads that
 * path, and nothing else, as that access would. It lasts `FILE_TICKET_TTL_MS` from when it was made
 * or last renewed: the driver that made it renews it while the device plays, and a ticket nobody
 * renews runs out. Kept in memory: after a restart, the driver gives its devices new ones.
 */

import type { Access } from '../../lib/access/types.ts';

/** How long a ticket lasts without being renewed. */
export const FILE_TICKET_TTL_MS = 5 * 60_000;

type FileTicket = { path: string; access: Access; expiresAt: number };

export class FileTickets {
  readonly #tickets = new Map<string, FileTicket>();

  /** A new ticket to read `path` as `access`. */
  issue(path: string, access: Access, now = Date.now()): string {
    this.#sweep(now);
    const ticket = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    this.#tickets.set(ticket, { path, access, expiresAt: now + FILE_TICKET_TTL_MS });
    return ticket;
  }

  /** Make `ticket` last another `FILE_TICKET_TTL_MS`; false when it has run out. */
  renew(ticket: string, now = Date.now()): boolean {
    this.#sweep(now);
    const held = this.#tickets.get(ticket);
    if (held) held.expiresAt = now + FILE_TICKET_TTL_MS;
    return held !== undefined;
  }

  drop(ticket: string): void {
    this.#tickets.delete(ticket);
  }

  /** The access `ticket` reads `path` with; undefined when it has run out or names another path. */
  access(ticket: string, path: string, now = Date.now()): Access | undefined {
    this.#sweep(now);
    const held = this.#tickets.get(ticket);
    return held?.path === path ? held.access : undefined;
  }

  #sweep(now: number): void {
    for (const [ticket, held] of this.#tickets) {
      if (held.expiresAt <= now) this.#tickets.delete(ticket);
    }
  }
}
