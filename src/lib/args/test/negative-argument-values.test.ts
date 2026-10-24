/**
 * A value that can be negative must be written `--flag=value`.
 *
 * `parseArgs` reads a token starting with `-` as the next flag, so `--lng -122.3493` does not pass
 * `-122.3493` to `--lng` — it passes the empty string, and `Number('')` is a perfectly valid `0`.
 * That is what makes the space form dangerous rather than merely broken: a command validating with
 * `Number.isFinite` accepts the zero and answers a different question than the one asked.
 *
 * Asserted over the source rather than at runtime because the damage is per call site, and a call
 * site is only wrong on the day someone drags the pin to the western hemisphere. Checks `src/` and
 * the modules alike. A positional argument with a leading `-` is beyond what this can see.
 */

import { assertEquals } from '@std/assert';
import { exists } from '@std/fs/exists';
import { walk } from '@std/fs/walk';
import { relative } from '@std/path';

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname;
const TREES = ['src', 'modules'];

/** Flags whose value can carry a leading `-`. */
const SPACE_FORM = /--(?:lat|lng|north|south|east|west|bbox|circle|alt) [-0-9$]/;

/** Prose explaining the rule has to be able to show the wrong form. */
const isComment = (line: string) => /^\s*(\*|\/\/)/.test(line);

const sources = async (): Promise<string[]> => {
  const out: string[] = [];
  for (const tree of TREES) {
    // A checkout need not have any modules.
    if (!await exists(`${REPO_ROOT}${tree}`)) continue;
    for await (const entry of walk(`${REPO_ROOT}${tree}`, { includeDirs: false, exts: ['.ts', '.tsx'] })) {
      // The built bundle is generated from the sources checked here.
      if (entry.path.includes('/ui/ui/')) continue;
      // This file states the rule, so it has to be able to spell out both forms.
      if (entry.path.endsWith('negative-argument-values.test.ts')) continue;
      out.push(entry.path);
    }
  }
  return out;
};

Deno.test('negative argument values', async (t) => {
  const files = await sources();

  await t.step('there are sources to check', () => {
    assertEquals(files.length > 100, true, `only found ${files.length} sources`);
  });

  await t.step('the pattern catches what it is for', () => {
    // A guard that matches nothing would pass forever.
    assertEquals(SPACE_FORM.test('execCommand(`position-set ${p} --lat ${lat} --lng ${lng}`)'), true);
    assertEquals(SPACE_FORM.test('find-within --north 90 --south -90'), true);
    assertEquals(SPACE_FORM.test('search --circle -33.9,18.4,5000'), true);
    // ...and does not fire on the correct form, or on an unrelated flag.
    assertEquals(SPACE_FORM.test('position-set /p --lat=57.7 --lng=11.97'), false);
    assertEquals(SPACE_FORM.test('find-within --north=90 --south=-90'), false);
    assertEquals(SPACE_FORM.test('generate-derivatives --size grid'), false);
  });

  await t.step('every call site uses the = form', () => {
    const offenders: string[] = [];

    for (const path of files) {
      for (const [n, line] of Deno.readTextFileSync(path).split('\n').entries()) {
        if (isComment(line)) continue;
        // `search` joins these itself in joinValueFlags, and search-faceted.test.ts passes the
        // space form deliberately to pin that. It is the only command that does.
        if (/\bsearch --circle -33\.9249/.test(line)) continue;
        // position-commands.test.ts asserts the space form still fails loudly rather than
        // reading a missing edge as 0.
        if (/shouldFailWith\('find-within --north 90/.test(line)) continue;
        if (SPACE_FORM.test(line)) offenders.push(`${relative(REPO_ROOT, path)}:${n + 1}: ${line.trim()}`);
      }
    }

    assertEquals(
      offenders,
      [],
      `write --flag=value; a negative value cannot survive the space form:\n  ${offenders.join('\n  ')}`,
    );
  });
});
