/**
 * Take a V8 heap snapshot from a running Deno process over the inspector protocol.
 *
 * The server must have been started with an inspector listening — see DENO_ARGS in the
 * Makefile:
 *
 *   DENO_ARGS='--inspect=127.0.0.1:9229' make container-run
 *
 * Then, from inside the same network namespace (the container itself, given --network=host):
 *
 *   deno run -A scripts/heap-snapshot.ts --out /files-tmp/heap-1.heapsnapshot
 *
 * Snapshots are written streaming, chunk by chunk, because they are larger than the heap
 * they describe — the point is to avoid a second process that also cannot hold it.
 * Analyse with scripts/heap-top.ts.
 */

import { parseArgs } from '@std/cli/parse-args';

type CdpTarget = { id: string; type: string; webSocketDebuggerUrl?: string };

const flags = parseArgs(Deno.args, {
  string: ['url', 'out'],
  default: { url: 'http://127.0.0.1:9229' },
});

const out = flags.out;

if (!out) {
  console.error('usage: heap-snapshot.ts --out <file> [--url http://127.0.0.1:9229]');
  Deno.exit(2);
}

const listUrl = `${flags.url.replace(/\/$/, '')}/json/list`;
const targets: CdpTarget[] = await (await fetch(listUrl)).json();
const target = targets.find((t) => t.webSocketDebuggerUrl);

if (!target?.webSocketDebuggerUrl) {
  console.error(`no debuggable target at ${listUrl}`);
  Deno.exit(1);
}

const file = await Deno.open(out, { create: true, write: true, truncate: true });
const encoder = new TextEncoder();
let bytes = 0;

const ws = new WebSocket(target.webSocketDebuggerUrl);
const done = Promise.withResolvers<void>();

ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'HeapProfiler.takeHeapSnapshot',
    // Roots matter for reading retainers later; progress reporting only adds noise.
    params: { reportProgress: false, treatGlobalObjectsAsRoots: true, captureNumericValue: false },
  }));
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    const chunk = encoder.encode(msg.params.chunk);
    bytes += chunk.length;
    await file.write(chunk);
    return;
  }

  if (msg.id === 1) {
    if (msg.error) {
      console.error(`takeHeapSnapshot failed: ${JSON.stringify(msg.error)}`);
      ws.close();
      done.reject(new Error('snapshot failed'));
      return;
    }

    ws.close();
    done.resolve();
  }
};

ws.onerror = () => done.reject(new Error('inspector websocket error'));

await done.promise;
file.close();

console.log(`wrote ${out} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
