import { assertEquals } from '@std/assert';
import plugin from '../../../../../../../scripts/lint-plugin.ts';

/** The lines `ein/ui-date-locale` refuses in `source`, read as a file at `path`. */
const refused = (source: string, path = '/ein/modules/demo/ui/page.tsx'): number[] =>
  Deno.lint.runPlugin(plugin, path, source)
    .filter((diagnostic) => diagnostic.id === 'ein/ui-date-locale')
    .map((diagnostic) => source.slice(0, diagnostic.range[0]).split('\n').length);

Deno.test("a date written in the browser's language is refused", () => {
  const source = [
    'const day = when.toLocaleDateString();',
    "const clock = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit' });",
    'const stamp = new Date(at).toLocaleString();',
    'const created = node.createdAt.toLocaleString();',
    "const short = value.toLocaleString('sv-SE', { dateStyle: 'short' });",
    "const format = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });",
    'const bare = Intl.DateTimeFormat().format(at);',
    'const empty = new Intl.DateTimeFormat([], {});',
    'const browser = new Intl.DateTimeFormat(navigator.language);',
  ].join('\n');
  assertEquals(refused(source), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

Deno.test('numbers, a named locale and the time zone are allowed', () => {
  const source = [
    'const count = total.toLocaleString();',
    "const pinned = files.toLocaleString('en');",
    'const share = ratio.toLocaleString(undefined, { maximumFractionDigits: 1 });',
    'const format = format.toLocaleString();',
    "const iso = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at);",
    'const own = new Intl.DateTimeFormat(locale, options);',
    'const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;',
  ].join('\n');
  assertEquals(refused(source), []);
});

Deno.test("core's shell is checked, and code outside the Web UI is not", () => {
  const source = 'const day = when.toLocaleDateString();';
  assertEquals(refused(source, '/ein/src/builtin/ui/src/client/pages/home.tsx'), [1]);
  assertEquals(refused(source, '/ein/src/managers/exec/commands/ls.ts'), []);
  assertEquals(refused(source, '/ein/modules/demo/lib/report.ts'), []);
});
