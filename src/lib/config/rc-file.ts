/**
 * Reading and writing the `export KEY='value'` files that hold configuration.
 *
 * The storage is deliberately a shell file rather than a node's attrs: every
 * EiN shell already sources `/etc/bashrc` at the end of `Shell.open()`, and
 * every command already reads its settings as `cmd.env.X || default`. Writing
 * a file that gets sourced therefore needs no new transport — the value is in
 * the environment of the next shell that opens, service shells included.
 *
 * The functions here are pure string transforms so they can be tested without
 * a VFS. The caller reads the file, applies one of these, and writes it back.
 */

/** A line this module wrote, or one close enough to it that we may rewrite it. */
const entryPattern = (key: string): RegExp => new RegExp(`^\\s*export\\s+${key}=`);

/**
 * Wrap a value in single quotes.
 *
 * Single quotes rather than double because a value is data, never something to
 * expand: a password or a caption prompt containing `$HOME` must survive as
 * those eight characters. `'` itself cannot appear inside single quotes at all,
 * so it is closed, escaped and reopened — the standard `'\''` dance.
 */
export const quoteRcValue = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Undo `quoteRcValue`, and the common hand-written forms besides. */
const unquoteRcValue = (raw: string): string => {
  const value = raw.trim();

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("'\\''", "'");
  }

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }

  return value;
};

/**
 * Every assignment in the file, last one winning.
 *
 * Last wins because that is what sourcing the file does, and a parser that
 * disagreed with the shell would report a value the system is not using.
 */
export const parseRc = (text: string): Map<string, string> => {
  const entries = new Map<string, string>();

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries.set(match[1], unquoteRcValue(match[2]));
  }

  return entries;
};

/**
 * Set `key`, rewriting an existing assignment in place.
 *
 * In place rather than appended, so the file stays the size of the settings it
 * holds rather than growing a line every time a value changes — it is meant to
 * be read by a person.
 *
 * Duplicates of `key` left by hand editing collapse to the single new line, at
 * the position of the *last* one — the one that was in effect.
 */
export const setRcEntry = (text: string, key: string, value: string): string => {
  const line = `export ${key}=${quoteRcValue(value)}`;
  const pattern = entryPattern(key);
  const lines = text.split('\n');

  const last = lines.reduce((found, current, index) => (pattern.test(current) ? index : found), -1);

  if (last === -1) {
    return appendLine(text, line);
  }

  return lines.flatMap((current, index) => {
    if (index === last) return [line];
    return pattern.test(current) ? [] : [current];
  }).join('\n');
};

/** Remove every assignment of `key`, reverting it to its default. */
export const unsetRcEntry = (text: string, key: string): string => {
  const pattern = entryPattern(key);
  const lines = text.split('\n').filter((line) => !pattern.test(line));
  return lines.join('\n');
};

/** Append a line, giving the file a trailing newline it may have lacked. */
const appendLine = (text: string, line: string): string => {
  if (text === '') return `${line}\n`;
  return text.endsWith('\n') ? `${text}${line}\n` : `${text}\n${line}\n`;
};

/**
 * Put `lines` at the end of the file, wherever they were before.
 *
 * The `source` lines have to be the last thing `/etc/bashrc` does, because
 * sourcing is last-wins and the settings files they source are meant to
 * override everything above them. They cannot simply be appended once and left
 * alone: the seed `src/builtin/core/etc/bashrc` carries them near the top, and
 * anything appended later would then win over `/etc/config`, which is exactly
 * backwards.
 *
 * Idempotent, so running it every boot neither duplicates nor reorders anything
 * that is already in place.
 */
export const withLinesLast = (text: string, lines: string[]): string => {
  const wanted = new Set(lines);
  const kept = text.split('\n').filter((line) => !wanted.has(line.trim()));

  // Collapse the blank line a removed block leaves behind, so re-running this
  // does not walk the file downwards one empty line at a time.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  return [...kept, ...lines, ''].join('\n');
};
