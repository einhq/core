/** An inclusive byte range, as `Range`/`Content-Range` express it. */
type ByteRange = {
  start: number;
  /** Inclusive — `Content-Range: bytes start-end/size`. */
  end: number;
};

/**
 * Parse a single-range HTTP `Range` header against a known resource size.
 *
 * Returns `undefined` when there is nothing to honour (absent header, a unit
 * other than bytes, unparseable, or more than one range — a multipart/byteranges
 * response is not worth the complexity, and every client falls back to a plain
 * 200 when the server ignores the header). Returns `'unsatisfiable'` only for a
 * syntactically valid range that starts past the end, which must answer 416
 * rather than 200.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return undefined;
  }

  const [, rawStart, rawEnd] = match;

  // `bytes=-N` asks for the last N bytes; N=0 is meaningless, not "the last zero bytes"
  if (rawStart === '') {
    if (rawEnd === '') {
      return undefined;
    }

    const suffix = Number(rawEnd);
    if (suffix === 0) {
      return 'unsatisfiable';
    }

    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) {
    return 'unsatisfiable';
  }

  // An end past the last byte is clamped rather than rejected, per RFC 9110
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) {
    return undefined;
  }

  return { start, end };
}
