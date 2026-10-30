import { expandCountFlag, parseArgs } from '../../../../lib/args/mod.ts';
import { resolve } from '@std/path';
import { deferred, Mutex } from '../../../../lib/async/mod.ts';
import { ResourceHandleIf, ResourceSeekMode } from '../../../../registries/types.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_LOG } from '../../../../vfs/types/log.ts';
import type { Command } from '../../command.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

const LOG_BATCH = 1000;
const READ_CHUNK = 65536;
const LINE_CHUNK = 8192;

/** A -n/-c count: 0 is a count, the default applies only when the flag is absent or not a number. */
const parseCount = (spec: string | undefined, fallback: number): number => {
  const n = spec === undefined ? NaN : parseInt(spec, 10);
  return Number.isNaN(n) ? fallback : Math.abs(n);
};

export const tail = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(expandCountFlag(cmd.args), {
    boolean: ['f'],
    alias: { n: 'lines', c: 'bytes', f: 'follow' },
    string: ['n', 'c'],
  });

  const pathArg = flags._[0] as string | undefined;

  if (pathArg === undefined || pathArg === '-') {
    return await tailStdin(cmd, flags);
  }

  const path = resolve(cmd.cwd, pathArg);
  const follow = flags.follow === true;

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);

    switch (node.type) {
      case NODE_TYPE_LOG:
        return await tailLog(cmd, path, flags, follow);
      case NODE_TYPE_FILE:
        return await tailFileBlob(cmd, path, node.type, flags, follow);
      default:
        await cmd.writeError(`tail: ${path}: unsupported node type '${node.type}'\n`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`tail: ${path}: ${message}\n`);
    return 1;
  }
};

/** Follow a log node: print the last N entries then block for new appends. */
const tailLog = async (
  cmd: Command,
  path: string,
  flags: ReturnType<typeof parseArgs>,
  follow: boolean,
): Promise<number> => {
  const count = parseCount(flags.lines, 10);
  const decoder = new TextDecoder();

  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    // History: the cursor goes N entries before the end (0: onto the last entry, so
    // nothing is read). On a short or empty log that throws and leaves the cursor at
    // the start, so everything is read.
    try {
      await handle.seek(-count, ResourceSeekMode.End);
    } catch {
      // From the beginning.
    }

    // Drain history without a signal so read() returns immediately at EOF.
    while (true) {
      const chunk = await handle.read(LOG_BATCH);
      if (chunk.length === 0) break;
      await writeLogEntries(cmd, decoder.decode(chunk));
    }

    if (!follow) return 0;

    // Follow: block on the log's waiter/LISTEN, waking on append or abort.
    const ac = new AbortController();
    cmd.onInterrupt(() => ac.abort());
    try {
      while (!ac.signal.aborted) {
        const chunk = await handle.read(LOG_BATCH, ac.signal);
        if (chunk.length === 0) break;
        await writeLogEntries(cmd, decoder.decode(chunk));
      }
    } finally {
      cmd.onInterrupt(null);
    }

    return cmd.interrupted ? 130 : 0;
  } finally {
    await handle.close();
  }
};

/** JSON values stay machine-readable; string entries read like ordinary log lines in a terminal. */
const writeLogEntries = async (cmd: Command, text: string): Promise<void> => {
  if (cmd.json) {
    await cmd.write(text);
    return;
  }

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let rendered = line;
    try {
      const data = JSON.parse(line);
      if (typeof data === 'string') rendered = data;
    } catch {
      // LogHandle emits JSON, but keep tail useful if another implementation
      // hands back an undecodable entry.
    }
    await cmd.write(`${rendered}\n`);
  }
};

/** Follow a file/blob node: print the tail then stream appends via VFS events. */
const tailFileBlob = async (
  cmd: Command,
  path: string,
  nodeType: string,
  flags: ReturnType<typeof parseArgs>,
  follow: boolean,
): Promise<number> => {
  let offset = 0;

  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    if (nodeType === NODE_TYPE_FILE) {
      const node = await cmd.sys.vfs.get(cmd.access, path);
      const mimetype = (node.attrs.mimetype as string | undefined) || '';
      if (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')) {
        await cmd.writeError(`tail: ${path}: not a text file\n`);
        return 1;
      }
    }

    if (flags.bytes) {
      await tailBytes(cmd, handle, flags.bytes);
    } else {
      await tailLines(cmd, handle, parseCount(flags.lines, 10));
    }

    offset = await handle.size();
  } finally {
    await handle.close();
  }

  if (!follow) return 0;

  const subscribe = cmd.sys.vfs.subscribe?.bind(cmd.sys.vfs);
  if (!subscribe) {
    await cmd.writeError('tail: -f is not supported on this backend\n');
    return 1;
  }

  const ac = new AbortController();
  const done = deferred<void>();
  cmd.onInterrupt(() => {
    ac.abort();
    done.resolve();
  });

  const mutex = new Mutex();
  const decoder = new TextDecoder();

  // Read everything appended since `offset` and stream it. Idempotent by
  // offset, so coalesced/overlapping events are safe.
  const pump = () =>
    mutex.withLock(async () => {
      if (ac.signal.aborted) return;
      const h = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
      try {
        const size = await h.size();
        if (size < offset) offset = 0; // truncated
        if (size > offset) {
          await h.seek(offset, ResourceSeekMode.Start);
          while (true) {
            const chunk = await h.read(READ_CHUNK);
            if (chunk.length === 0) break;
            await cmd.write(decoder.decode(chunk, { stream: true }));
          }
          offset = size;
        }
      } finally {
        await h.close();
      }
    });

  const sub = await subscribe(
    () => cmd.access,
    () => pump(),
    { pathPrefix: path, recursive: false, eventTypes: ['updated'], nodeTypes: [nodeType] },
  );

  try {
    // Catch up on anything appended between the size snapshot and subscribe.
    await pump();
    await done;
  } finally {
    await sub.unsubscribe();
    cmd.onInterrupt(null);
  }

  return 130;
};

/** Read exactly `length` bytes from the current position (handles short reads). */
const readExactly = async (handle: ResourceHandleIf, length: number): Promise<Uint8Array> => {
  const buf = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const chunk = await handle.read(length - filled);
    if (chunk.length === 0) break;
    buf.set(chunk, filled);
    filled += chunk.length;
  }
  return filled === length ? buf : buf.subarray(0, filled);
};

/** Print the last N lines of a seekable handle via a backward chunked read. */
const tailLines = async (cmd: Command, handle: ResourceHandleIf, count: number): Promise<void> => {
  if (count <= 0) return;
  const size = await handle.size();
  if (size === 0) return;

  let pos = size;
  let newlines = 0;
  const parts: Uint8Array[] = [];

  while (pos > 0 && newlines <= count) {
    const step = Math.min(LINE_CHUNK, pos);
    pos -= step;
    await handle.seek(pos, ResourceSeekMode.Start);
    const chunk = await readExactly(handle, step);
    parts.unshift(chunk);
    for (const b of chunk) {
      if (b === 0x0a) newlines++;
    }
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    all.set(p, cursor);
    cursor += p.length;
  }

  const text = new TextDecoder().decode(all);
  const endsWithNewline = text.endsWith('\n');
  let lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  lines = lines.slice(-count);

  for (const line of lines) {
    await cmd.write(`${line}\n`);
  }
};

/** Print the last N bytes (or from byte +N) of a seekable handle. */
const tailBytes = async (cmd: Command, handle: ResourceHandleIf, spec: string): Promise<void> => {
  const size = await handle.size();
  const fromStart = spec.startsWith('+');
  const count = parseCount(fromStart ? spec.slice(1) : spec, fromStart ? 1 : 0);

  const start = fromStart ? Math.min(size, Math.max(0, count - 1)) : Math.max(0, size - count);
  await handle.seek(start, ResourceSeekMode.Start);

  const decoder = new TextDecoder();
  while (true) {
    const chunk = await handle.read(READ_CHUNK);
    if (chunk.length === 0) break;
    await cmd.write(decoder.decode(chunk, { stream: true }));
  }
};

/** tail as a pipe filter: buffer stdin, then slice. */
const tailStdin = async (cmd: Command, flags: ReturnType<typeof parseArgs>): Promise<number> => {
  const input = await cmd.stdin.text();
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');

  if (input.length === 0) {
    return 0;
  }

  if (flags.bytes) {
    const fromStart = flags.bytes.startsWith('+');
    const count = parseCount(fromStart ? flags.bytes.slice(1) : flags.bytes, fromStart ? 1 : 0);
    const bytes = new TextEncoder().encode(input);
    const slice = fromStart ? bytes.slice(Math.max(0, count - 1)) : bytes.slice(Math.max(0, bytes.length - count));
    await cmd.write(new TextDecoder().decode(slice));
  } else {
    let count = 10;
    let fromStart = false;

    if (flags.lines) {
      fromStart = flags.lines.startsWith('+');
      count = parseCount(fromStart ? flags.lines.slice(1) : flags.lines, 10);
    }

    const endsWithNewline = input.endsWith('\n');
    let lines = input.split('\n');
    if (endsWithNewline && lines[lines.length - 1] === '') {
      lines.pop();
    }

    lines = fromStart ? lines.slice(Math.max(0, count - 1)) : lines.slice(Math.max(0, lines.length - count));

    for (const line of lines) {
      await cmd.write(`${line}\n`);
    }
  }

  return 0;
};

tail.spec = {
  name: 'tail',
  effect: 'read' as const,
  json: false,
  description: 'Output the last part of files, logs, or stdin (with -f to follow)',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'log/file/blob node to read (stdin if omitted, or for -)',
      optional: true,
    },
  ],
  flags: [
    { name: 'n', type: 'string' as const, description: 'output the last NUM lines, or use +NUM for starting at line NUM (-NUM works too)' },
    { name: 'c', type: 'string' as const, description: 'output the last NUM bytes, or use +NUM for starting at byte NUM' },
    {
      name: 'f',
      type: 'bool' as const,
      description: 'follow: keep the output live as the log/file grows',
    },
  ],
};
