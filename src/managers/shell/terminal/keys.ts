/**
 * Terminal input as key events. The reader is fed the bytes as they arrive; an escape sequence or
 * a UTF-8 character cut at the end of one chunk is finished by the next.
 */

/** Typed text, a bracketed paste, or a named key with its modifiers. */
export type Key =
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'key'; name: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_FINAL: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab' };
const SS3_FINAL: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const TILDE: Record<string, string> = { '1': 'home', '7': 'home', '4': 'end', '8': 'end', '2': 'insert', '3': 'delete', '5': 'pageup', '6': 'pagedown', '13': 'f3' };

/** The modifiers an xterm parameter (`1;5` → ctrl) encodes: one plus a bit set of shift, alt, ctrl. */
function modifiers(param: string | undefined): { ctrl?: boolean; shift?: boolean; alt?: boolean } {
  const bits = Number(param ?? '1') - 1;
  if (!(bits > 0)) return {};
  return { ...(bits & 1 ? { shift: true } : {}), ...(bits & 2 ? { alt: true } : {}), ...(bits & 4 ? { ctrl: true } : {}) };
}

export class KeyReader {
  private decoder = new TextDecoder();
  private pending = '';
  /** The text of a bracketed paste so far, while one is open. */
  private paste: string | undefined;

  /** The keys in the next chunk of input. */
  feed(bytes: Uint8Array): Key[] {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const keys: Key[] = [];
    let text = '';
    const flushText = () => {
      if (text) keys.push({ type: 'text', text });
      text = '';
    };
    const input = this.pending;
    let i = 0;

    while (i < input.length) {
      if (this.paste !== undefined) {
        const end = input.indexOf(PASTE_END, i);
        if (end < 0) {
          // Keep back what could be the start of the end marker.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, input.length - i); n > 0; n--) {
            if (PASTE_END.startsWith(input.slice(input.length - n))) {
              keep = n;
              break;
            }
          }
          this.paste += input.slice(i, input.length - keep);
          i = input.length - keep;
          break;
        }
        keys.push({ type: 'paste', text: (this.paste + input.slice(i, end)).replace(/\r\n?/g, '\n') });
        this.paste = undefined;
        i = end + PASTE_END.length;
        continue;
      }

      const c = input[i];
      if (c === '\x1b') {
        const parsed = this.escape(input, i);
        if (parsed === 'incomplete') break;
        flushText();
        if (parsed.paste) this.paste = '';
        else if (parsed.key) keys.push(parsed.key);
        i = parsed.next;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) {
        text += c;
        i++;
        continue;
      }
      flushText();
      if (c === '\r') {
        keys.push({ type: 'key', name: 'enter' });
        i += input[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (c === '\n') keys.push({ type: 'key', name: 'enter' });
      else if (c === '\t') keys.push({ type: 'key', name: 'tab' });
      else if (c === '\x7f' || c === '\x08') keys.push({ type: 'key', name: 'backspace' });
      else if (code >= 1 && code <= 26) keys.push({ type: 'key', name: String.fromCharCode(code + 96), ctrl: true });
      i++;
    }

    flushText();
    this.pending = input.slice(i);
    return keys;
  }

  /** The escape sequence at `i`: a key, the start of a paste, nothing known, or not all here yet. */
  private escape(input: string, i: number): { key?: Key; paste?: boolean; next: number } | 'incomplete' {
    const next = input[i + 1];
    // A lone ESC at the end of what arrived is the Escape key: terminals send a sequence whole.
    if (next === undefined) return { key: { type: 'key', name: 'escape' }, next: i + 1 };
    if (next === '[') {
      let j = i + 2;
      while (j < input.length && /[0-9;:<=>?]/.test(input[j])) j++;
      if (j >= input.length) return 'incomplete';
      const final = input[j];
      const params = input.slice(i + 2, j).split(';');
      const sequence = input.slice(i, j + 1);
      if (sequence === PASTE_START) return { paste: true, next: j + 1 };
      if (final === '~') {
        const name = TILDE[params[0]];
        return { key: name ? { type: 'key', name, ...modifiers(params[1]) } : undefined, next: j + 1 };
      }
      const name = CSI_FINAL[final];
      if (!name) return { next: j + 1 };
      return { key: { type: 'key', name, ...(final === 'Z' ? { shift: true } : modifiers(params[1])) }, next: j + 1 };
    }
    if (next === 'O') {
      const final = input[i + 2];
      if (final === undefined) return 'incomplete';
      const name = SS3_FINAL[final];
      return { key: name ? { type: 'key', name } : undefined, next: i + 3 };
    }
    if (next === '\x1b') return { key: { type: 'key', name: 'escape' }, next: i + 1 };
    // ESC before a character is Alt with it.
    const char = String.fromCodePoint(input.codePointAt(i + 1)!);
    const name = char === '\x7f' ? 'backspace' : char === '\r' ? 'enter' : char.toLowerCase();
    return { key: { type: 'key', name, alt: true }, next: i + 1 + char.length };
  }
}
