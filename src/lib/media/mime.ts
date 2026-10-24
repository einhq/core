import { extname } from '@std/path';
import mimeBytes from 'mime-bytes';
import mimeBytesRegistry from 'mime-bytes/file-types-registry.js';
import { Buffer } from 'node:buffer';
import { getRawMimeFromName, refineMimeByName } from './raw.ts';

export const MIME_DEFAULT_TYPE = 'application/octet-stream' as const;
/** How much of a file's head `getMimeFromBuffer` reads: the text sample, and three transport-stream packets. */
export const MIME_SAMPLE_BYTES = 512 as const;
/** How much of the head mime-bytes is shown: every signature it checks lies within it. */
const MIME_SIGNATURE_BYTES = 32;

export async function getMimeFromExt(filename: string, defaultType: string = MIME_DEFAULT_TYPE): Promise<string> {
  return getRawMimeFromName(filename) ?? (mimeBytesRegistry.getContentTypeByExtension(extname(filename)) || defaultType);
}

// The camera RAW tables and the name refinement live in `raw.ts`, which imports no sniffer: the
// module contract exports them.
export { isRawExtension, isRawMimetype, RAW_IMAGE_EXTENSIONS, RAW_IMAGE_MIMETYPES, refineMimeByName } from './raw.ts';

// ISO-BMFF major brands (ftyp box) the sniffer gets wrong, keyed by the 4 bytes at offset 8.
//
// mime-bytes has no AVIF signature at all, so an AVIF falls through
// to the generic 4-byte `ftyp` match and comes back as video/mp4 — which get-file then serves
// as Content-Type and the browser refuses to render. Every image derivative is AVIF, so this
// map is load-bearing, not a nicety. `heix` is in the same position upstream, and so is a
// Canon CR3, which would otherwise be filed and processed as a video.
const FTYP_IMAGE_BRANDS: Record<string, string> = {
  'avif': 'image/avif',
  'avis': 'image/avif',
  'heix': 'image/heic',
  'crx ': 'image/x-canon-cr3',
};

// MP4-container brands (ftyp box) that are audio-only. mime-bytes resolves `M4A ` on its own,
// but not M4B/M4P.
const MP4_AUDIO_BRANDS = ['M4A ', 'M4B ', 'M4P '];

// Formats whose files begin with text by design, so a head that is clean text does not rule them
// out. Every other signature mime-bytes knows belongs to a binary format.
const TEXT_HEADED_MIMETYPES = new Set([
  'application/pdf',
  'application/postscript',
  'application/eps',
  'application/rtf',
  'application/xml',
  'application/x-archive',
  'application/x-debian-package',
]);

const TS_SYNC_BYTE = 0x47;

// MPEG transport-stream packets: 188 bytes, or 192 behind a 4-byte timestamp (`.mts`, `.m2ts`)
const TS_PACKETS = [{ size: 188, offset: 0 }, { size: 192, offset: 4 }];

/** Whether the head is an MPEG transport stream: the sync byte opens at least two packets, and every one the sample reaches. */
function isTransportStream(bytes: Uint8Array): boolean {
  return TS_PACKETS.some(({ size, offset }) => {
    if (bytes.length <= offset + size) {
      return false;
    }
    for (let at = offset; at < bytes.length; at += size) {
      if (bytes[at] !== TS_SYNC_BYTE) {
        return false;
      }
    }
    return true;
  });
}

/**
 * The mimetype the head of a file sniffs as. Given the file's `name`, a name that decides over a
 * weak sniff — a camera RAW's, a `.json` or an `.xmp` sidecar's — does (`refineMimeByName`).
 */
export async function getMimeFromBuffer(bytes: Uint8Array, name?: string): Promise<string> {
  const sniffed = await sniffMime(bytes);
  return name === undefined ? sniffed : refineMimeByName(sniffed, name);
}

async function sniffMime(bytes: Uint8Array): Promise<string> {
  const mimeResult = await mimeBytes.detectFromBuffer(bytes.slice(0, MIME_SIGNATURE_BYTES) as Buffer);
  const mimetype = mimeResult ? mimeResult.mimeType : MIME_DEFAULT_TYPE;

  // A head that is clean text is text, whatever binary signature mime-bytes matched at its start:
  // it takes as little as "G" for MPEG-TS, "BM" for a bitmap or "ID3" for an MP3, and prose
  // begins with those. For clean text without a signature mime-bytes answers a bare
  // `text/plain`; the heuristic also reads what a script's first line says about it.
  if (!TEXT_HEADED_MIMETYPES.has(mimetype)) {
    const text = getMimeFromTextHeuristic(bytes);
    if (text) {
      return text;
    }
  }

  // mime-bytes guesses `text/plain` (at half confidence) from the first MIME_SIGNATURE_BYTES
  // alone; a sample that holds a NUL further on is bytes. A Fujifilm RAF opens with an ASCII
  // header. Text mime-bytes knows by its byte-order mark (UTF-16) is a signature, not a guess.
  if (mimetype === 'text/plain' && mimeResult && mimeResult.confidence < 1 && bytes.subarray(0, MIME_SAMPLE_BYTES).includes(0)) {
    return MIME_DEFAULT_TYPE;
  }

  // mime-bytes takes any leading 0x47 for MPEG-TS and never looks for 192-byte packets; the
  // packet structure decides
  if (mimetype === 'video/mp2t' || mimetype === MIME_DEFAULT_TYPE) {
    return isTransportStream(bytes) ? 'video/mp2t' : MIME_DEFAULT_TYPE;
  }

  // The generic sniffer reports every unrecognised ISO-BMFF container as video/mp4; the major
  // brand is what actually distinguishes still images and audio-only files
  if (mimetype === 'video/mp4' && bytes.length >= 12) {
    const brand = new TextDecoder().decode(bytes.subarray(8, 12));

    const imageType = FTYP_IMAGE_BRANDS[brand];
    if (imageType) {
      return imageType;
    }

    if (MP4_AUDIO_BRANDS.includes(brand)) {
      return 'audio/mp4';
    }
  }

  return mimetype;
}

/**
 * What a shebang's interpreter name says the script is. `bash`, `ts` and the
 * other bare names are EiN's own convention — there is no `/bin/bash` in this
 * system, so a file the system writes starts with `#!bash` rather than a host
 * path — but a script that came in from outside keeps its `#!/usr/bin/env bash`
 * and is read the same way.
 */
const SHEBANG_INTERPRETER_MIMETYPES: Record<string, string> = {
  bash: 'text/x-shellscript',
  sh: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  dash: 'text/x-shellscript',
  ksh: 'text/x-shellscript',
  ts: 'text/typescript',
  deno: 'text/typescript',
  js: 'text/javascript',
  node: 'text/javascript',
  python: 'text/x-python',
  python3: 'text/x-python',
};

/** The mimetype for a shebang line (`#!bash`, `#!ts`, `#!/usr/bin/env python3`). */
export function getMimeFromShebang(line: string): string {
  const words = line.replace(/^#!/, '').trim().split(/\s+/);
  let interpreter = words[0]?.split('/').pop() ?? '';
  // `env` names the real interpreter next, after its own flags (`env -S deno run`)
  if (interpreter === 'env') interpreter = words.slice(1).find((w) => !w.startsWith('-'))?.split('/').pop() ?? '';
  return SHEBANG_INTERPRETER_MIMETYPES[interpreter.toLowerCase()] ?? 'text/x-shellscript';
}

/**
 * Whether content is text: a shebang or a clean UTF-8 sample (no NUL bytes)
 * is. Returns undefined for binary/empty.
 */
export function getMimeFromTextHeuristic(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  const sample = bytes.subarray(0, MIME_SAMPLE_BYTES);
  if (sample.includes(0)) return undefined;
  let text: string;
  try {
    // stream: true tolerates a multi-byte sequence cut at the sample boundary
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
  } catch {
    return undefined;
  }
  if (sample[0] === 0x23 && sample[1] === 0x21) return getMimeFromShebang(text.split(/\r?\n/, 1)[0]);
  return 'text/plain';
}

/** Mimetypes that say "bytes" or "some text", not what kind — a sniff may know better. */
export const isUntypedMimetype = (mimetype: string | null | undefined): boolean => !mimetype || mimetype === MIME_DEFAULT_TYPE || mimetype === 'text/plain';

/** Mimetypes whose content is text to read or edit: `text/*` and the data and script types filed under `application/`. */
export const isTextMimetype = (mimetype: string): boolean => {
  const mime = mimetype.split(';')[0].trim().toLowerCase();
  return mime.startsWith('text/') || mime.endsWith('+json') || mime.endsWith('+xml') || mime.endsWith('yaml') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-sh'].includes(mime);
};
