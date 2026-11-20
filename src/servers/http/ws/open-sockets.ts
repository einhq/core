/**
 * The server's open WebSockets. A stopping server closes them itself with 1001 (going away):
 * left to `Deno.serve`'s shutdown, each ends with 1005 on the wire, a reserved code the browser
 * rejects as a broken close frame.
 */
export class OpenSockets {
  readonly #sockets = new Set<WebSocket>();

  /** `Deno.upgradeWebSocket`, keeping the socket until it closes. */
  upgrade(req: Request): { socket: WebSocket; response: Response } {
    const upgraded = Deno.upgradeWebSocket(req);
    const { socket } = upgraded;
    this.#sockets.add(socket);
    socket.addEventListener('close', () => this.#sockets.delete(socket));
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
