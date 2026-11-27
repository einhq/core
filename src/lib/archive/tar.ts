/**
 * Reading a tar archive as a stream of entries, each entry's bytes streamed in turn, so neither the
 * archive nor an entry is held in memory.
 *
 * It reads the POSIX ustar format with its `prefix`, GNU's long names and link names (`L`, `K`),
 * pax extended headers (`x`: `path`, `linkpath`, `size`; global ones, `g`, are passed over) and
 * GNU's base-256 sizes. An archive ends at its first zero block or at the end of its bytes,
 * whichever comes first: GNU tar's end of two zero blocks is not required, so one ending in a lone
 * zero block, or none, or with the last entry's padding cut off, reads in full.
 */

/** What an entry is. `other` is a device, a fifo or anything else that holds no bytes to expand. */
type TarEntryKind = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

export type TarEntry = {
  /** The entry's path as the archive names it, long names and the ustar prefix applied. */
  path: string;
  kind: TarEntryKind;
  /** The header's type flag, as one character. */
  typeflag: string;
  /** The bytes of a file; 0 for anything else. */
  size: number;
  mode: number;
  mtime: Date;
  /** What a symlink points at, or the earlier entry's path a hard link names; '' for others. */
  linkname: string;
  /**
   * The entry's bytes, as they are read. Reading them is optional: the next entry is read past
   * whatever is left. Read them before asking for the next entry, or not at all.
   */
  body(): AsyncGenerator<Uint8Array>;
};

/** A tar archive that cannot be read: a header that is not one, or bytes that end inside an entry. */
class TarFormatError extends Error {}

const BLOCK = 512;

/**
 * Reads exactly the bytes asked for from a stream of chunks of any size, keeping what one read took
 * ahead for the next.
 */
class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  /** Bytes handed out so far. */
  position = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** The next chunk of at most `max` bytes, or undefined at the end of the stream. */
  async next(max: number): Promise<Uint8Array | undefined> {
    while (this.#offset >= this.#chunk.length) {
      const { done, value } = await this.#reader.read();
      if (done) return undefined;
      this.#chunk = value;
      this.#offset = 0;
    }
    const part = this.#chunk.subarray(this.#offset, this.#offset + max);
    this.#offset += part.length;
    this.position += part.length;
    return part;
  }

  /** Exactly `length` bytes, or fewer when the stream ends first. */
  async exactly(length: number): Promise<Uint8Array> {
    const first = await this.next(length);
    if (!first || first.length === length) return first ?? new Uint8Array(0);
    const out = new Uint8Array(length);
    out.set(first);
    let filled = first.length;
    while (filled < length) {
      const part = await this.next(length - filled);
      if (!part) return out.subarray(0, filled);
      out.set(part, filled);
      filled += part.length;
    }
    return out;
  }

  /** Pass over `length` bytes; false when the stream ends first. */
  async skip(length: number): Promise<boolean> {
    let left = length;
    while (left > 0) {
      const part = await this.next(left);
      if (!part) return false;
      left -= part.length;
    }
    return true;
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {});
  }
}

const decoder = new TextDecoder();

/** A NUL-terminated string field. */
const text = (block: Uint8Array, start: number, length: number): string => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};

/** A numeric field: octal digits, or GNU's base-256 when its first byte's high bit is set. */
const number = (block: Uint8Array, start: number, length: number): number => {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = decoder.decode(field).replace(/\0.*$/s, '').trim();
  return digits === '' ? 0 : parseInt(digits, 8);
};

/** Whether `block` is a header: its checksum field matches the sum of its bytes, the field counted as spaces. */
const checksumMatches = (block: Uint8Array): boolean => {
  const stored = number(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
};

/** The records of a pax extended header: `<length> <key>=<value>\n`, each. */
const paxRecords = (bytes: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space === -1) break;
    const length = parseInt(decoder.decode(bytes.subarray(at, space)), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
};

const kindOf = (typeflag: string): TarEntryKind => {
  switch (typeflag) {
    case '0':
    case '\0':
    case '7':
      return 'file';
    case '5':
      return 'directory';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    default:
      return 'other';
  }
};

/** The bytes of an entry's data, padding included, rounded up to whole blocks. */
const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

/**
 * The entries of the tar archive `stream` holds. The stream is cancelled when the entries end or the
 * caller stops early.
 *
 * @throws TarFormatError at a header that is not one, or when the bytes end inside an entry
 */
export async function* readTar(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(stream);
  // Names and sizes the special entries before an entry give it.
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();

  const readData = async (size: number): Promise<Uint8Array> => {
    const bytes = await reader.exactly(size);
    if (bytes.length < size || !(await reader.skip(padded(size) - size))) throw new TarFormatError('the archive ends inside a header');
    return bytes;
  };

  try {
    while (true) {
      const at = reader.position;
      const block = await reader.exactly(BLOCK);
      if (block.length === 0 || block.every((byte) => byte === 0)) return;
      if (block.length < BLOCK) throw new TarFormatError(`the archive ends inside a header, at byte ${at}`);
      if (!checksumMatches(block)) {
        throw new TarFormatError(at === 0 ? 'not a tar archive' : `the header at byte ${at} is damaged: its checksum does not match`);
      }

      const typeflag = decoder.decode(block.subarray(156, 157));
      let size = number(block, 124, 12);

      if (typeflag === 'L' || typeflag === 'K') {
        const name = text(await readData(size), 0, size);
        if (typeflag === 'L') longName = name;
        else longLink = name;
        continue;
      }
      if (typeflag === 'x' || typeflag === 'g') {
        const records = paxRecords(await readData(size));
        if (typeflag === 'x') pax = records;
        continue;
      }

      // POSIX ustar's prefix; GNU's own format keeps other fields in those bytes.
      const posix = text(block, 257, 6) === 'ustar' && block[262] === 0;
      const prefix = posix ? text(block, 345, 155) : '';
      const name = text(block, 0, 100);
      const path = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name);
      const linkname = pax.get('linkpath') ?? longLink ?? text(block, 157, 100);
      if (pax.has('size')) size = Number(pax.get('size'));
      const mtime = pax.has('mtime') ? Number(pax.get('mtime')) : number(block, 136, 12);
      longName = longLink = undefined;
      pax = new Map();

      let kind = kindOf(typeflag);
      if (kind === 'file' && path.endsWith('/')) kind = 'directory';
      // Only a file's bytes follow its header; a directory or a link that says it has some has
      // them passed over all the same, as GNU tar does.
      const dataBytes = kind === 'file' || kind === 'other' ? size : 0;
      const skipData = kind === 'directory' || kind === 'symlink' || kind === 'hardlink' ? size : 0;

      let left = dataBytes;
      let finished = false;
      const body = async function* (): AsyncGenerator<Uint8Array> {
        if (finished) return;
        finished = true;
        while (left > 0) {
          const part = await reader.next(left);
          if (!part) throw new TarFormatError(`the archive ends inside ${path}`);
          left -= part.length;
          yield part;
        }
      };

      yield {
        path,
        kind,
        typeflag,
        size: kind === 'file' ? size : 0,
        mode: number(block, 100, 8),
        mtime: new Date(mtime * 1000),
        linkname: kind === 'symlink' || kind === 'hardlink' ? linkname : '',
        body,
      };

      finished = true;
      if (!(await reader.skip(left))) throw new TarFormatError(`the archive ends inside ${path}`);
      // Padding cut off after the last entry's bytes ends the archive, as no end blocks do.
      if (!(await reader.skip(padded(dataBytes) - dataBytes + padded(skipData)))) return;
    }
  } finally {
    await reader.cancel();
  }
}
