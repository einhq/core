/**
 * Quote a value for interpolation into a shell command string.
 *
 * Node names routinely contain characters the shell acts on: `&` splits the
 * command (`Anna_&_Erik` would run `_Erik` as a command), and `"`, `?`, `!`,
 * `,` and `$` all appear in album names.
 * Double quotes are not enough — they still expand `$` and backticks.
 *
 * Single quotes suppress everything; the only character that needs handling is
 * a single quote itself, closed and reopened around an escaped one.
 */
export const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
