/**
 * A node's attributes as a flat list of dotted keys, and back.
 *
 * `{ contact: { email: 'a@b' }, labels: ['x', 'y'] }` becomes
 * `contact.email`, `labels.0`, `labels.1` — one row per leaf, which is what a
 * table can show and edit. Going back rebuilds the top-level values, because
 * that is the unit `attrs -J key=json` writes: the command takes a key
 * literally, so a dotted key sent to it would become a new attribute called
 * `contact.email` rather than a change inside `contact`.
 */

export type FlatAttr = { key: string; value: unknown };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function flattenAttrs(attrs: Record<string, unknown>, prefix = ''): FlatAttr[] {
  const out: FlatAttr[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (isPlainObject(value) && Object.keys(value).length > 0) out.push(...flattenAttrs(value, key));
    else if (Array.isArray(value) && value.length > 0) out.push(...flattenAttrs(Object.fromEntries(value.map((item, index) => [String(index), item])), key));
    else out.push({ key, value });
  }
  return out;
}

/**
 * Rebuild nested values from dotted keys. A segment that is an index of a
 * list that was a list stays a list; there is no way to tell `labels.0` from
 * an object with a key `0` from the key alone, so the original is consulted.
 */
export function unflattenAttrs(rows: FlatAttr[], original: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of rows) {
    const parts = key.split('.');
    let target: Record<string, unknown> | unknown[] = out;
    let source: unknown = original;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const sourceChild = isPlainObject(source) ? source[part] : Array.isArray(source) ? source[Number(part)] : undefined;
      const nextIsList = Array.isArray(sourceChild) || (sourceChild === undefined && /^\d+$/.test(parts[i + 1]));
      const existing = Array.isArray(target) ? target[Number(part)] : target[part];
      let next: Record<string, unknown> | unknown[];
      if (existing && typeof existing === 'object') next = existing as Record<string, unknown> | unknown[];
      else {
        next = nextIsList ? [] : {};
        if (Array.isArray(target)) target[Number(part)] = next;
        else target[part] = next;
      }
      target = next;
      source = sourceChild;
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(target)) target[Number(last)] = value;
    else target[last] = value;
  }
  // A list rebuilt from rows that skipped an index would carry holes.
  const compact = (value: unknown): unknown =>
    Array.isArray(value) ? value.filter(() => true).map(compact) : isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)])) : value;
  return compact(out) as Record<string, unknown>;
}

/** The top-level keys whose values differ between two attribute sets. */
export function changedTopLevel(before: Record<string, unknown>, after: Record<string, unknown>): { set: string[]; unset: string[] } {
  const set: string[] = [];
  const unset: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) unset.push(key);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) set.push(key);
  }
  return { set, unset };
}

/** A leaf as text for an input: strings bare, everything else as JSON. */
export const attrText = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);

/** Text from an input back to a value: JSON when it parses and the original was not a string, else the text. */
export function attrValue(text: string, original: unknown): unknown {
  if (typeof original === 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The `attrs` flags that turn `before` into `after`, one per changed
 * top-level key: `-J key=json` to set, `-d key` to remove. Each is quoted for
 * the shell; empty when nothing changed.
 */
export function attrsWriteArgs(before: Record<string, unknown>, after: Record<string, unknown>, quote: (text: string) => string): string[] {
  const { set, unset } = changedTopLevel(before, after);
  return [
    ...set.map((key) => `-J ${quote(`${key}=${JSON.stringify(after[key])}`)}`),
    ...unset.map((key) => `-d ${quote(key)}`),
  ];
}

export type ParsedAttrs = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/**
 * A node's attributes typed as JSON: an object, whose keys `attrs -J key=…`
 * can carry — not empty, and without the `=` that ends the key there.
 */
export function parseAttrsJson(text: string): ParsedAttrs {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'The attributes must be one JSON object: { "key": value, … }.' };
  for (const key of Object.keys(value)) {
    if (key.trim() === '') return { ok: false, message: 'An attribute needs a name.' };
    if (key.includes('=')) return { ok: false, message: `"${key}": a name cannot contain "=".` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
