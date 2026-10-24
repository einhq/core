import { resolve } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ulid } from '@std/ulid';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { isTextMimetype } from '../../../../lib/media/mime.ts';
import { highlighter, languageFor } from '../../../shell/terminal/mod.ts';
import { NODE_TYPE_EMBEDDING } from '../../../../vfs/types/embedding.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_POSITION } from '../../../../vfs/types/position.ts';
import { NODE_TYPE_LOG } from '../../../../vfs/types/log.ts';
import { NODE_TYPE_NULL } from '../../../../vfs/types/null.ts';
import { NODE_TYPE_POOL } from '../../../../vfs/types/pool.ts';
import { NODE_TYPE_QUEUE } from '../../../../vfs/types/queue.ts';
import { NODE_TYPE_ROUTER } from '../../../../vfs/types/router.ts';
import { LogHandle } from '../../../../registries/log/mod.ts';
import type { Command } from '../../command.ts';
import { signalExitCode } from '../../signal.ts';
import type { CmdReturn } from '../../types.ts';

const LOG_BATCH = 1000;

/** Stdin to stdout as it arrives, until it ends or the command is interrupted. */
const catStdin = async (cmd: Command): CmdReturn => {
  const decoder = new TextDecoder();
  for await (const chunk of cmd.stdin.chunks()) await cmd.write(decoder.decode(chunk, { stream: true }));
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  const rest = decoder.decode();
  if (rest) await cmd.write(rest);
  return 0;
};

type CatFlags = { s: boolean; l: boolean; t: boolean };

export const cat = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['s', 'l', 't'],
    alias: { s: 'small', l: 'large', t: 'timestamps' },
  });
  // No file, or `-`: copy stdin, as cat does — what `cat > file <<'EOF'` and `… | cat` rely on.
  const operands = flags._.length === 0 ? ['-'] : flags._.map(String);
  let status = 0;
  for (const operand of operands) {
    const code = operand === '-' ? await catStdin(cmd) : await catNode(cmd, resolve(cmd.cwd, operand), flags);
    if (cmd.interrupted) return code;
    if (code !== 0) status = 1;
  }
  return status;
};

/** One node's contents, as its type has them. */
const catNode = async (cmd: Command, path: string, flags: CatFlags): CmdReturn => {
  const highlight = highlighter(!cmd.tty);
  let mediaLines = Number.parseInt(cmd.env.MEDIA_LINES || '20');
  const encoder = new TextDecoder();

  if (flags.s) {
    mediaLines = Math.floor(mediaLines / 2);
  } else if (flags.l) {
    mediaLines = mediaLines * 2;
  }

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);

    switch (node.type) {
      case NODE_TYPE_LOG: {
        // Read without a signal: a log read given one blocks at the end for new
        // appends, which is `tail -f`, not cat.
        const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
        try {
          // A log's entries carry the time they were written, which `read()` drops: a weight
          // series without its dates is a list of numbers. `-t` keeps it, one entry a line.
          if (flags.t && handle instanceof LogHandle) {
            while (!cmd.interrupted) {
              const entries = await handle.readEntries(LOG_BATCH);
              if (entries.length === 0) break;
              await cmd.write(entries.map((entry) => `${entry.createdAt.toISOString()}\t${JSON.stringify(entry.data)}\n`).join(''));
            }
            return cmd.interrupted ? 130 : 0;
          }
          while (!cmd.interrupted) {
            const chunk = await handle.read(LOG_BATCH);
            if (chunk.length === 0) break;
            await cmd.write(encoder.decode(chunk));
          }
        } finally {
          await handle.close();
        }
        return cmd.interrupted ? 130 : 0;
      }

      case NODE_TYPE_NULL:
        return 0;

      case NODE_TYPE_ROUTER:
      // A pool streams a snapshot of its ready backlog and ends; unlike a
      // queue, reading it does not consume anything.
      case NODE_TYPE_POOL:
      case NODE_TYPE_QUEUE: {
        const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
        try {
          const stream = handle.readable;
          const reader = stream.getReader();

          cmd.onInterrupt(() => {
            reader.cancel();
          });

          let hasNewline = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done || cmd.interrupted) break;
            if (value) {
              const data = encoder.decode(value);
              await cmd.write(data);

              hasNewline = data.endsWith('\n');
            }
          }

          if (!hasNewline) {
            await cmd.write('\n');
          }

          cmd.onInterrupt(null);
        } finally {
          await handle.close();
        }
        return cmd.interrupted ? 130 : 0;
      }

      case NODE_TYPE_EMBEDDING:
      case NODE_TYPE_POSITION: {
        const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
        try {
          const content = await toText(handle.readable);

          // A position node exists before it has a shape, and an embedding before it is computed — that is empty
          // content, not a parse error.
          if (content.trim() === '') return 0;

          await cmd.writeJSON(JSON.parse(content));
        } finally {
          await handle.close();
        }
        return 0;
      }

      case NODE_TYPE_FILE: {
        const attrs = node.attrs as { mimetype?: string };
        const mimetype = attrs.mimetype || '';
        const outputId = ulid();

        // Media is written as markers, one per line of the preview, which the terminal renders.
        if (mimetype.startsWith('image/')) {
          for (let i = 0; i < mediaLines; i++) {
            await cmd.write(`__IMG:${path}:${outputId}:${mediaLines}:${i}\n`);
          }
          return 0;
        }

        if (mimetype.startsWith('video/')) {
          for (let i = 0; i < mediaLines; i++) {
            await cmd.write(`__VID:${path}:${outputId}:${mediaLines}:${i}\n`);
          }
          return 0;
        }

        if (mimetype.startsWith('audio/')) {
          for (let i = 0; i < 2; i++) {
            await cmd.write(`__AUD:${path}:${outputId}:${2}:${i}\n`);
          }
          return 0;
        }

        if (isTextMimetype(mimetype)) {
          const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
          try {
            const content = await toText(handle.readable);

            const lang = languageFor({ name: path, mimetype, firstLine: content.split('\n', 1)[0] });
            if (lang) {
              await cmd.write(highlight(content, lang));
            } else {
              await cmd.write(content);
            }
          } finally {
            await handle.close();
          }
          return 0;
        }

        await cmd.writeError(`cat: ${path}: unsupported mimetype '${mimetype}'\n`);
        return 1;
      }

      default:
        await cmd.writeError(`cat: ${path}: unsupported node type '${node.type}'\n`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await cmd.writeError(`cat: ${path}: ${message}\n`);
    return 1;
  }
};

cat.spec = {
  name: 'cat',
  effect: 'read' as const,
  json: false,
  description: "Print nodes' contents, one after the other: a text file, a log (one JSON entry a line), a position or an embedding (JSON)",
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'nodes to output, one after the other; without one, or for -, stdin is copied',
      variadic: true,
    },
  ],
  flags: [
    { name: 's', type: 'bool' as const, description: 'small media preview (mediaLines / 2)' },
    { name: 'l', type: 'bool' as const, description: 'large media preview (mediaLines * 2)' },
    { name: 't', type: 'bool' as const, description: "log: each entry's time (ISO 8601, UTC) first, a tab, then the entry" },
    { name: 'timestamps', type: 'bool' as const, description: "log: each entry's time (ISO 8601, UTC) first, a tab, then the entry" },
  ],
  examples: [
    'cat /archive/albums/Exempelalbum_2019/files/notes.txt',
    'cat -t /archive/people/Anna_Exempel/measurements/weight',
  ],
  returns: 'the node\'s contents; with -t on a log, lines like 2016-09-04T16:13:27.739Z<TAB>{"value":83.4}.',
};
