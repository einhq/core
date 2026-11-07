/**
 * The input monitor ends a typed line with LF in cooked mode, as a terminal's ICRNL does, and
 * forwards the bytes unchanged in raw mode, where the line editor reads them.
 */

import { assertEquals } from '@std/assert';
import { InputMonitor, type TerminalMode } from '../input-monitor.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';

async function forward(mode: TerminalMode, typed: string): Promise<string> {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => (send = c) });
  const written: Uint8Array[] = [];
  let wrote!: () => void;
  const done = new Promise<void>((resolve) => (wrote = resolve));
  const monitor = new InputMonitor({
    rawStdin: { readable } as unknown as ResourceHandleIf,
    filteredStdin: {
      write: (bytes: Uint8Array) => {
        written.push(bytes);
        wrote();
        return Promise.resolve(bytes.length);
      },
    } as unknown as ResourceHandleIf,
    onSignal: () => {},
  });
  monitor.setMode(mode);
  await monitor.start();
  send.enqueue(new TextEncoder().encode(typed));
  await done;
  monitor.stop();
  return written.map((b) => new TextDecoder().decode(b)).join('');
}

Deno.test('cooked mode turns Enter into a line end', async () => {
  assertEquals(await forward('cooked', 'typed\r'), 'typed\n');
});

Deno.test('cooked mode keeps a typed LF', async () => {
  assertEquals(await forward('cooked', 'typed\n'), 'typed\n');
});

Deno.test('raw mode forwards CR unchanged', async () => {
  assertEquals(await forward('raw', 'typed\r'), 'typed\r');
});
