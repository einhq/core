/** How many sockets visitors — the guest, a share link's — may hold open from one address. */
export const VISITOR_SOCKETS_PER_ADDRESS = 32;

/** How many sockets visitors may hold open from all addresses together. */
const VISITOR_SOCKETS = 512;

/**
 * The server's open WebSockets. A stopping server closes them itself with 1001 (going away):
 * left to `Deno.serve`'s shutdown, each ends with 1005 on the wire, a reserved code the browser
 * rejects as a broken close frame.
 *
 * A visitor's socket holds a shell and its session, so visitors' are counted by the address they
 * come from, and refused past `VISITOR_SOCKETS_PER_ADDRESS` from one and `VISITOR_SOCKETS` in all.
 * Someone signed in is not counted.
 */
export class OpenSockets {
  readonly #sockets = new Set<WebSocket>();
  readonly #visitors = new Map<string, number>();
  #visitorCount = 0;

  /** Whether a visitor from `address` may open another socket. */
  admitsVisitor(address: string): boolean {
    return this.#visitorCount < VISITOR_SOCKETS && (this.#visitors.get(address) ?? 0) < VISITOR_SOCKETS_PER_ADDRESS;
  }

  /**
   * `Deno.upgradeWebSocket`, keeping the socket until it closes; counted against `visitor`, the
   * address of a visitor's, until then.
   */
  upgrade(req: Request, visitor?: string): { socket: WebSocket; response: Response } {
    const upgraded = Deno.upgradeWebSocket(req);
    const { socket } = upgraded;
    this.#sockets.add(socket);
    if (visitor !== undefined) {
      this.#visitors.set(visitor, (this.#visitors.get(visitor) ?? 0) + 1);
      this.#visitorCount++;
    }
    socket.addEventListener('close', () => {
      this.#sockets.delete(socket);
      if (visitor === undefined) return;
      const left = (this.#visitors.get(visitor) ?? 1) - 1;
      if (left > 0) this.#visitors.set(visitor, left);
      else this.#visitors.delete(visitor);
      this.#visitorCount--;
    });
    return upgraded;
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.#sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close(code, reason);
        } catch { /* closing already */ }
      }
    }
  }
}
