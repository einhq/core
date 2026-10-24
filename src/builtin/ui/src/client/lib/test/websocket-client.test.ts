import { assertEquals } from '@std/assert';
import { WebSocketClient } from '../WebSocketClient.ts';

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test({
  name: 'interactive WebSocket client restores before live output and queued input',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const abort = new AbortController();
    const listening = Promise.withResolvers<number>();
    const received: string[] = [];
    const server = Deno.serve({
      port: 0,
      hostname: '127.0.0.1',
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'restore',
          snapshot: 'saved-screen',
          rows: 24,
          cols: 80,
          pwd: '/tmp',
          resumed: true,
        }));
        socket.send('live-output');
      };
      socket.onmessage = (event) => received.push(String(event.data));
      return response;
    });

    const port = await listening.promise;
    const events: string[] = [];
    const client = new WebSocketClient('/__shell?mode=interactive&terminalId=test', {
      protocol: 'http:',
      host: `127.0.0.1:${port}`,
    } as Location);

    try {
      client.onRestore(async (restore) => {
        events.push(`restore-start:${restore.snapshot}:${restore.pwd}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push('restore-end');
      });
      client.onConnectState((connected) => {
        if (connected) events.push('connected');
      });
      client.onData((data) => events.push(`data:${data}`));

      client.send('queued-input');
      client.sendResize(100, 30);
      client.connect();

      await waitFor(() => received.includes('queued-input'), 'queued input was not delivered');
      await waitFor(() => events.includes('data:live-output'), 'live output was not delivered');
      assertEquals(events, [
        'restore-start:saved-screen:/tmp',
        'restore-end',
        'connected',
        'data:live-output',
      ]);
      assertEquals(received, [JSON.stringify({ type: 'resize', cols: 100, rows: 30 }), 'queued-input']);
    } finally {
      client.close();
      abort.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: 'interactive WebSocket client forks instead of retrying when its terminal is attached elsewhere',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const abort = new AbortController();
    const listening = Promise.withResolvers<number>();
    let connections = 0;
    const server = Deno.serve({
      port: 0,
      hostname: '127.0.0.1',
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    }, (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.onopen = () => {
        connections++;
        socket.close(4001, 'terminal attached elsewhere');
      };
      return response;
    });

    const port = await listening.promise;
    const client = new WebSocketClient('/__shell?mode=interactive&terminalId=copied', {
      protocol: 'http:',
      host: `127.0.0.1:${port}`,
    } as Location);
    let conflicts = 0;

    try {
      client.onTerminalConflict(() => conflicts++);
      client.connect();

      await waitFor(() => conflicts === 1, 'terminal ownership conflict was not reported');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assertEquals(connections, 1);
      assertEquals(client.isConnected(), false);
    } finally {
      client.close();
      abort.abort();
      await server.finished;
    }
  },
});
