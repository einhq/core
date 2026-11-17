/**
 * `template` with each `$NAME` of `vars` replaced by its value, in one pass over the template:
 * a value is never scanned again, so a file name holding `$NODE_PATH` stays inside the quotes
 * `shq` gave it. A `$NAME` not in `vars` is left as is, for the shell.
 */
export const substitute = (template: string, vars: Record<string, string>): string => {
  // Longest name first: otherwise `$EVENT_TYPE` would eat the prefix of
  // `$EVENT_TYPE_HINT` and leave a mangled tail behind.
  const names = Object.keys(vars).sort((a, b) => b.length - a.length);
  if (names.length === 0) return template;
  const pattern = new RegExp(`\\$(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return template.replace(pattern, (_, name: string) => vars[name]);
};
