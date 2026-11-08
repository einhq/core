/**
 * The input monitor ends a typed line with LF in cooked mode, as a terminal's ICRNL does, and
 * forwards the bytes unchanged in raw mode, where the line editor reads them. In cooked mode
 * Ctrl-D marks end of file after what was typed before it.
 */

import { assertEquals } from '@std/assert';
import { InputMonitor, type TerminalMode } from '../input-monitor.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';

/** What the monitor passes on for what was typed, with `<EOF>` where it marks end of file. */
async function forward(mode: TerminalMode, typed: string): Promise<string> {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => (send = c) });
  const written: string[] = [];
  const monitor = new InputMonitor({
    rawStdin: { readable } as unknown as ResourceHandleIf,
    filteredStdin: {
      write: (bytes: Uint8Array) => {
        written.push(new TextDecoder().decode(bytes));
        return Promise.resolve(bytes.length);
      },
      markEOF: () => {
        written.push('<EOF>');
      },
      dropEOFMarks: () => {},
    },
    onInterrupt: () => {},
  });
  monitor.setMode(mode);
  await monitor.start();
  send.enqueue(new TextEncoder().encode(typed));
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitor.stop();
  return written.join('');
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

Deno.test('cooked mode turns Ctrl-D into an end-of-file mark after what came before it', async () => {
  assertEquals(await forward('cooked', 'ab\x04c'), 'ab<EOF>c');
});

Deno.test('raw mode forwards Ctrl-D unchanged', async () => {
  assertEquals(await forward('raw', '\x04'), '\x04');
});
