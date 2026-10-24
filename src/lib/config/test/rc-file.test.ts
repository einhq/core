import { MOD_PATH } from '../../paths.ts';
import { assertEquals } from '@std/assert';
import { parseRc, quoteRcValue, setRcEntry, unsetRcEntry, withLinesLast } from '../rc-file.ts';

Deno.test('rc-file', async (t) => {
  await t.step('sets a key on an empty file', () => {
    assertEquals(setRcEntry('', 'CFG_CPU_SLOTS', '4'), "export CFG_CPU_SLOTS='4'\n");
  });

  await t.step('appends to a file without a trailing newline', () => {
    assertEquals(
      setRcEntry("export CFG_A='1'", 'CFG_B', '2'),
      "export CFG_A='1'\nexport CFG_B='2'\n",
    );
  });

  await t.step('rewrites in place rather than appending', () => {
    const text = "export CFG_A='1'\nexport CFG_B='2'\nexport CFG_C='3'\n";
    assertEquals(
      setRcEntry(text, 'CFG_B', '9'),
      "export CFG_A='1'\nexport CFG_B='9'\nexport CFG_C='3'\n",
    );
  });

  await t.step('setting the same key twice leaves one line', () => {
    const once = setRcEntry('', 'CFG_A', '1');
    const twice = setRcEntry(once, 'CFG_A', '2');
    assertEquals(twice, "export CFG_A='2'\n");
  });

  await t.step('collapses hand-written duplicates onto the last position', () => {
    const text = "export CFG_A='1'\nexport CFG_B='x'\nexport CFG_A='2'\n";
    assertEquals(setRcEntry(text, 'CFG_A', '3'), "export CFG_B='x'\nexport CFG_A='3'\n");
  });

  await t.step('a key is not a prefix of another key', () => {
    const text = "export CFG_MODE='a'\nexport CFG_MODE_EXTRA='b'\n";
    assertEquals(
      setRcEntry(text, 'CFG_MODE', 'z'),
      "export CFG_MODE='z'\nexport CFG_MODE_EXTRA='b'\n",
    );
  });

  await t.step('quotes values so nothing expands', () => {
    // A caption prompt or a password may contain any of these; sourcing the
    // file must yield the characters back, not a variable expansion.
    assertEquals(quoteRcValue('$HOME and `date`'), "'$HOME and `date`'");
    assertEquals(quoteRcValue("it's"), "'it'\\''s'");
    assertEquals(parseRc(setRcEntry('', 'CFG_A', "it's $HOME")).get('CFG_A'), "it's $HOME");
    assertEquals(parseRc(setRcEntry('', 'CFG_A', 'two words')).get('CFG_A'), 'two words');
  });

  await t.step('unsets every assignment of a key', () => {
    const text = "export CFG_A='1'\nexport CFG_B='2'\nexport CFG_A='3'\n";
    assertEquals(unsetRcEntry(text, 'CFG_A'), "export CFG_B='2'\n");
  });

  await t.step('unsetting a key that is not there changes nothing', () => {
    const text = "export CFG_B='2'\n";
    assertEquals(unsetRcEntry(text, 'CFG_A'), text);
  });

  await t.step('parses the last assignment, as sourcing would', () => {
    const entries = parseRc("export CFG_A='1'\n# comment\nexport CFG_A='2'\nnot a line\n");
    assertEquals(entries.get('CFG_A'), '2');
    assertEquals(entries.size, 1);
  });

  await t.step('parses hand-written double-quoted and bare values', () => {
    const entries = parseRc('export CFG_A="two words"\nexport CFG_B=3\n');
    assertEquals(entries.get('CFG_A'), 'two words');
    assertEquals(entries.get('CFG_B'), '3');
  });
});

Deno.test('withLinesLast', async (t) => {
  const lines = ['[ -r /etc/config ] && source /etc/config', 'source "$HOME/.config"'];

  await t.step('moves lines that are already present to the end', () => {
    const text = ['# seed', lines[0], lines[1], `export PATH="$PATH:${MOD_PATH}/archive/bin"`, "export CFG_A='1'"].join('\n');
    const result = withLinesLast(text, lines);

    assertEquals(result.split('\n').slice(-3, -1), lines);
    assertEquals(result.split('\n').filter((line) => line === lines[0]).length, 1);
  });

  await t.step('appends them when they are absent', () => {
    assertEquals(withLinesLast("export CFG_A='1'\n", lines), ["export CFG_A='1'", ...lines, ''].join('\n'));
  });

  await t.step('is idempotent, and does not drift downwards on repeat', () => {
    const once = withLinesLast("export CFG_A='1'\n", lines);
    assertEquals(withLinesLast(once, lines), once);
    assertEquals(withLinesLast(withLinesLast(once, lines), lines), once);
  });
});
