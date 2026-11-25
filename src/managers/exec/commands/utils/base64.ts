/**
 * base64: encode FILE, or stdin when there is none or it is `-`, as base64 (RFC 4648), or decode it
 * with -d. Bytes in and bytes out, so a binary file passes through a pipe and a redirect unchanged.
 *
 * As in GNU coreutils: encoded lines wrap at 76 characters, -w COLS (also -wCOLS and --wrap=COLS)
 * sets the width and -w 0 does not wrap at all; decoding skips newlines, stops at anything else
 * outside the alphabet with `invalid input` unless -i drops it, takes padded groups one after
 * another (`YQ==Yg==`), and writes what it decoded before an error or an unpadded end.
 */

import { encodeBase64 } from '@std/encoding/base64';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = 0x3d;
const NEWLINE = 0x0a;

/** Each byte's value in the alphabet, -1 for one outside it. */
const VALUES = new Int8Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/** Encodes a byte stream chunk by chunk, wrapping at `wrap` columns (0: never). */
export class Base64Encoder {
  private carry = new Uint8Array(0);
  private column = 0;

  constructor(private wrap: number) {}

  /** The text for `chunk`; up to two bytes wait for the next one to make a whole group. */
  push(chunk: Uint8Array): string {
    const bytes = this.carry.length > 0 ? concat(this.carry, chunk) : chunk;
    const whole = bytes.length - (bytes.length % 3);
    this.carry = bytes.slice(whole);
    return this.wrapped(encodeBase64(bytes.subarray(0, whole)));
  }

  /** The padded last group, and the newline that ends the last line when wrapping. */
  end(): string {
    const text = this.wrapped(encodeBase64(this.carry));
    this.carry = new Uint8Array(0);
    return this.wrap > 0 && this.column > 0 ? `${text}\n` : text;
  }

  private wrapped(text: string): string {
    if (this.wrap === 0 || text === '') return text;
    let out = '';
    let at = 0;
    while (at < text.length) {
      const take = Math.min(this.wrap - this.column, text.length - at);
      out += text.slice(at, at + take);
      at += take;
      this.column += take;
      if (this.column === this.wrap) {
        out += '\n';
        this.column = 0;
      }
    }
    return out;
  }
}

/** Decodes a base64 stream chunk by chunk; `invalid` is set at the first byte it cannot take. */
export class Base64Decoder {
  invalid = false;
  /** The values of the group being read, and how many of its places are filled (a `=` fills one). */
  private group = new Uint8Array(4);
  private filled = 0;
  private pads = 0;

  constructor(private ignoreGarbage: boolean) {}

  /** The bytes `chunk` completes; empty once the input was found invalid. */
  push(chunk: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.ceil((this.filled + chunk.length) / 4) * 3);
    let length = 0;
    for (const byte of chunk) {
      if (this.invalid) break;
      if (byte === NEWLINE) continue;
      if (byte === PAD) {
        // Padding fills the third and fourth places only, and nothing but more of it follows.
        if (this.filled < 2) this.invalid = true;
        else {
          this.pads++;
          this.filled++;
        }
      } else if (VALUES[byte] >= 0 && this.pads === 0) {
        this.group[this.filled++] = VALUES[byte];
      } else if (!this.ignoreGarbage || VALUES[byte] >= 0) {
        this.invalid = true;
      }
      if (this.filled === 4) {
        length = this.flush(out, length);
        this.filled = 0;
        this.pads = 0;
      }
    }
    return out.subarray(0, length);
  }

  /** The bytes of an unpadded last group, which also makes the input invalid, as in GNU base64. */
  end(): Uint8Array {
    if (this.invalid || this.filled === 0) return new Uint8Array(0);
    this.invalid = true;
    const out = new Uint8Array(3);
    return out.subarray(0, this.flush(out, 0));
  }

  /** Writes the group's bytes into `out` at `at`: one for two values, two for three, three for four. */
  private flush(out: Uint8Array, at: number): number {
    const [a, b, c, d] = this.group;
    const values = this.filled - this.pads;
    if (values >= 2) out[at++] = (a << 2) | (b >> 4);
    if (values >= 3) out[at++] = ((b & 0x0f) << 4) | (c >> 2);
    if (values >= 4) out[at++] = ((c & 0x03) << 6) | d;
    this.group.fill(0);
    return at;
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export const base64 = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    alias: { d: 'decode', i: 'ignore-garbage', w: 'wrap' },
    boolean: ['decode', 'ignore-garbage'],
    string: ['wrap'],
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const files = flags._.map(String);
  if (files.length > 1) {
    await cmd.writeError(`base64: extra operand '${files[1]}'\n`);
    return 1;
  }
  let wrap = 76;
  if (flags.wrap !== undefined) {
    wrap = /^\d+$/.test(flags.wrap) ? Number(flags.wrap) : NaN;
    if (!Number.isSafeInteger(wrap)) {
      await cmd.writeError(`base64: invalid wrap size: '${flags.wrap}'\n`);
      return 1;
    }
  }

  const inputs = operands(cmd, files);
  for await (const input of inputs) {
    if (flags.decode) {
      const decoder = new Base64Decoder(flags['ignore-garbage']);
      for await (const chunk of input.chunks()) {
        const bytes = decoder.push(chunk);
        if (bytes.length > 0) await cmd.write(bytes);
        if (decoder.invalid) break;
      }
      const rest = decoder.end();
      if (rest.length > 0) await cmd.write(rest);
      if (decoder.invalid && !cmd.interrupted) {
        await cmd.writeError('base64: invalid input\n');
        return 1;
      }
    } else {
      const encoder = new Base64Encoder(wrap);
      for await (const chunk of input.chunks()) {
        const text = encoder.push(chunk);
        if (text !== '') await cmd.write(text);
      }
      const rest = encoder.end();
      if (rest !== '') await cmd.write(rest);
    }
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return inputs.failed ? 1 : 0;
};

base64.spec = {
  name: 'base64',
  effect: 'read' as const,
  json: false,
  description: 'Encode bytes as base64 text, or decode it with -d',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'the file to encode or decode (reads from stdin if omitted, or for -)',
    },
  ],
  flags: [
    { name: 'd', type: 'bool' as const, description: 'decode (--decode)' },
    { name: 'i', type: 'bool' as const, description: 'when decoding, drop what is not of the alphabet (--ignore-garbage)' },
    { name: 'w', type: 'number' as const, description: 'wrap encoded lines at COLS characters, 0 for none (--wrap; default 76)' },
  ],
  examples: [
    "echo 'aGVsbG8K' | base64 -d > ~/hello.txt",
    'base64 -w 0 ~/photo.jpg',
  ],
  returns: 'the encoded text, or the decoded bytes.',
};
