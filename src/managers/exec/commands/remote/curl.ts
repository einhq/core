/**
 * `curl`: fetch a URL over HTTP or HTTPS, as curl does for a plain GET. The body goes to stdout, or
 * with `-o`/`-O` into a file in the VFS, written the way an upload is — size, checksum and type
 * recorded afterwards — so the media pipelines take it in.
 *
 * The request starts on the machine EiN runs on, which can reach the household's own network, so
 * only the administrator may run it.
 */

import { resolve } from '@std/path';
import * as posix from '@std/path/posix';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';
import { createFileAttrsCollector } from '../../../../lib/media/file-attrs.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import { NodeNotFoundError } from '../../../../vfs/errors.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** curl's exit status for an HTTP error with `-f` */
const HTTP_ERROR = 22;

/** A one-line progress meter on stderr, redrawn at most every 250 ms */
class Progress {
  private started = Date.now();
  private drawn = 0;
  private done = 0;

  constructor(private cmd: Command, private name: string, private size: number | undefined, private enabled: boolean) {}

  stream(): TransformStream<Uint8Array, Uint8Array> {
    return new TransformStream({
      transform: async (chunk, controller) => {
        controller.enqueue(chunk);
        this.done += chunk.length;
        if (this.enabled && Date.now() - this.drawn > 250) await this.draw();
      },
    });
  }

  async finish(): Promise<void> {
    if (!this.enabled) return;
    await this.draw();
    await this.cmd.writeError('\n');
  }

  private async draw() {
    this.drawn = Date.now();
    const secs = Math.max((this.drawn - this.started) / 1000, 0.001);
    const pct = this.size ? `${String(Math.floor(this.done / this.size * 100)).padStart(3)}%` : '    ';
    const rate = `${humanizeSize(this.done / secs)}/s`;
    const width = Math.max(this.cmd.cols - 32, 10);
    const name = this.name.length > width ? this.name.slice(0, width - 1) + '…' : this.name.padEnd(width);
    await this.cmd.writeError(`\r${name} ${pct} ${humanizeSize(this.done).padStart(9)} ${rate.padStart(11)}`);
  }
}

/** The file name `-O` saves a URL as: the last segment of its path, decoded */
function remoteName(url: URL): string {
  const last = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Write `body` to the VFS file at `path`, made when it is missing and replaced when it is there. */
async function saveTo(cmd: Command, path: string, body: ReadableStream<Uint8Array>, progress: Progress): Promise<void> {
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const name = posix.basename(path);

  let fh;
  try {
    fh = await vfs.open(access, path, { mode: 'w' });
  } catch (error) {
    if (!(error instanceof NodeNotFoundError)) throw error;
    await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, posix.dirname(path), name, {
      attrs: { name, mimetype: 'application/octet-stream', size: 0 },
    });
    fh = await vfs.open(access, path, { mode: 'w' });
  }

  const collector = createFileAttrsCollector(name);
  try {
    await body.pipeThrough(progress.stream()).pipeThrough(collector.stream).pipeTo(fh.writable);
  } catch (error) {
    await fh.close().catch(() => {});
    throw error;
  }
  // Closing the handle is what records the size and sha256 of what was written.
  await fh.close();
  await progress.finish();

  // As an upload does: recording what the bytes are is what starts the pipelines.
  await vfs.update<FileAttrs>(access, path, { attrs: await collector.finalize() });
}

export const curl = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['L', 'f', 's', 'O'],
    string: ['o', 'H'],
    collect: ['H'],
    alias: { L: 'location', f: 'fail', s: 'silent', O: 'remote-name', o: 'output', H: 'header' },
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  if (!isAdmin(cmd.access)) {
    await cmd.writeError('curl: permission denied, only the administrator may fetch URLs\n');
    return 1;
  }

  if (flags._.length !== 1) {
    await cmd.writeError('usage: curl [-fLOs] [-o file] [-H header] url\n');
    return 2;
  }

  let url: URL;
  try {
    url = new URL(String(flags._[0]));
  } catch {
    await cmd.writeError(`curl: malformed URL: ${flags._[0]}\n`);
    return 3;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    await cmd.writeError(`curl: protocol "${url.protocol.slice(0, -1)}" not supported\n`);
    return 1;
  }

  const headers = new Headers();
  for (const header of flags.H as string[]) {
    const at = header.indexOf(':');
    if (at <= 0) {
      await cmd.writeError(`curl: malformed header: ${header}\n`);
      return 2;
    }
    headers.append(header.slice(0, at).trim(), header.slice(at + 1).trim());
  }

  let output: string | undefined;
  if (flags.o !== undefined) {
    output = resolve(cmd.cwd, flags.o);
  } else if (flags.O) {
    const name = remoteName(url);
    if (!name) {
      await cmd.writeError('curl: remote file name has no length; use -o\n');
      return 23;
    }
    output = resolve(cmd.cwd, name);
  }

  if (output !== undefined) {
    const existing = await cmd.sys.vfs.get(cmd.access, output).catch(() => undefined);
    if (existing && existing.type !== NODE_TYPE_FILE) {
      await cmd.writeError(`curl: ${output}: not a file\n`);
      return 23;
    }
  }

  const abort = new AbortController();
  cmd.onInterrupt(() => abort.abort());
  try {
    const response = await fetch(url, { headers, redirect: flags.L ? 'follow' : 'manual', signal: abort.signal });
    if (flags.f && response.status >= 400) {
      await response.body?.cancel();
      await cmd.writeError(`curl: (22) The requested URL returned error: ${response.status}\n`);
      return HTTP_ERROR;
    }
    if (!response.body) return 0;

    if (output === undefined) {
      for await (const chunk of response.body) await cmd.write(chunk);
      return 0;
    }

    const length = Number(response.headers.get('content-length'));
    const progress = new Progress(cmd, posix.basename(output), length > 0 ? length : undefined, cmd.tty && !flags.s);
    await saveTo(cmd, output, response.body, progress);
    return 0;
  } catch (error) {
    if (abort.signal.aborted) return 130;
    await cmd.writeError(`curl: ${(error as Error).message}\n`);
    return 1;
  } finally {
    cmd.onInterrupt(null);
  }
};

curl.spec = {
  name: 'curl',
  effect: 'write' as const,
  json: false,
  description: 'Fetch a URL over HTTP or HTTPS, to stdout or into a file (administrator only)',
  args: [{ name: 'url', type: 'string' as const, description: 'an http:// or https:// URL' }],
  flags: [
    { name: 'o', type: 'path' as const, description: 'write the body to this file instead of stdout' },
    { name: 'O', type: 'bool' as const, description: "write the body to a file named as the URL's last part, in the current directory" },
    { name: 'L', type: 'bool' as const, description: 'follow redirects' },
    { name: 'f', type: 'bool' as const, description: 'fail with status 22, writing nothing, when the server answers with an error (400 or above)' },
    { name: 's', type: 'bool' as const, description: 'no progress meter' },
    { name: 'H', type: 'string' as const, repeatable: true, description: 'a request header, "Name: value"' },
  ],
  examples: [
    'curl -fLO https://example.com/files/sailboat.jpg',
    'curl -fL -o /home/anna/report.pdf https://example.com/download?id=7',
    'curl -s https://example.com/status.json | jq .version',
  ],
  returns: 'the body on stdout, or nothing with -o or -O; 22 for an HTTP error with -f, 1 when the request failed.',
};
