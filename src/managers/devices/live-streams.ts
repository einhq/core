/**
 * Live streams and sets of files a driver serves a device on the network: a page the media service
 * renders for a screen, a video made as HLS while it plays, which the screen's player fetches
 * itself, with no session. A stream is served at `/live/<id>.mp4` and `/live/<id>.ts`, a set's files
 * at `/live/<id>/<name>`, to whoever has the path, its id long and random, until the driver ends it
 * or a stream's source says it has ended. Kept in memory.
 */

import type { LiveFormat, LiveOpen, ServedFile, ServedFiles } from './types.ts';

type Served = { kind: 'stream'; open: LiveOpen } | { kind: 'files'; get: ServedFiles };

export class LiveStreams {
  readonly #streams = new Map<string, Served>();

  /** Serve `open` under a new id; answers the id. */
  serve(open: LiveOpen): string {
    return this.#add({ kind: 'stream', open });
  }

  /** Serve the files `get` makes under a new id; answers the id. */
  serveFiles(get: ServedFiles): string {
    return this.#add({ kind: 'files', get });
  }

  #add(served: Served): string {
    const id = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    this.#streams.set(id, served);
    return id;
  }

  end(id: string): void {
    this.#streams.delete(id);
  }

  /**
   * One reader's bytes of the stream `id` in `format`; undefined when there is no such stream, or
   * its source says it has ended, when it is no longer served.
   */
  async open(id: string, format: LiveFormat): Promise<ReadableStream<Uint8Array> | undefined> {
    const served = this.#streams.get(id);
    if (served?.kind !== 'stream') return undefined;
    const body = await served.open(format);
    if (!body) this.#streams.delete(id);
    return body;
  }

  /** The file `name` of the set `id`; undefined when there is no such set or it has no such file. */
  async file(id: string, name: string): Promise<ServedFile | undefined> {
    const served = this.#streams.get(id);
    return served?.kind === 'files' ? await served.get(name) : undefined;
  }
}
