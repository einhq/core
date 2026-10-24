/**
 * Every core caller goes through `lib/args`'s parseArgs, not `@std/cli`'s.
 *
 * The wrapper splits a value attached to a short option off into its own argument (`-d:` -> `-d`
 * `:`). `@std/cli` only does that when the value is a number, so `-f2` parses and `-d:` sets the
 * delimiter to `''` — and an empty delimiter is not an error, `line.split('')` cuts the line into
 * characters, so `cut -d" " -f2` would return the second *character* (ein/core#62).
 *
 * Asserted over the source because the wrapper is a no-op for a command that declares no
 * single-letter value option — every direct `@std/cli` import in the tree is correct until the
 * day someone adds a `-x <value>` flag to it, at which point it is silently wrong. The import is
 * the only moment anyone will look.
 */

import { assertEquals } from '@std/assert';
import { walk } from '@std/fs/walk';
import { relative } from '@std/path';

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname;

/** An import of the parser core code must not reach for directly. */
const DIRECT_IMPORT = /\bfrom\s+'@std\/cli\/parse-args'/;

/** Prose explaining the rule has to be able to name what it bans. */
const isComment = (line: string) => /^\s*(\*|\/\/)/.test(line);

const sources = async (): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of walk(`${REPO_ROOT}src`, { includeDirs: false, exts: ['.ts', '.tsx'] })) {
    // The wrapper is the one place that wraps it.
    if (entry.path.endsWith('/lib/args/mod.ts')) continue;
    // This file states the rule, so it has to be able to spell out the banned form.
    if (entry.path.endsWith('parse-args-wrapper.test.ts')) continue;
    out.push(entry.path);
  }
  return out;
};

Deno.test('parseArgs comes from lib/args', async (t) => {
  const files = await sources();

  await t.step('there are sources to check', () => {
    // A glob that silently matches nothing would make the assertion below vacuous.
    assertEquals(files.length > 100, true, `only found ${files.length} sources`);
  });

  await t.step('the pattern catches what it is for', () => {
    assertEquals(DIRECT_IMPORT.test("import { parseArgs } from '@std/cli/parse-args';"), true);
    assertEquals(DIRECT_IMPORT.test("import { parseArgs as p } from '@std/cli/parse-args';"), true);
    // ...and not on the wrapper's own import, nor on unrelated @std/cli utilities.
    assertEquals(DIRECT_IMPORT.test("import { parseArgs } from '../../../../lib/args/mod.ts';"), false);
    assertEquals(DIRECT_IMPORT.test("import { promptSecret } from '@std/cli/prompt-secret';"), false);
  });

  await t.step('no core source imports @std/cli/parse-args', () => {
    const offenders: string[] = [];

    for (const path of files) {
      for (const [n, line] of Deno.readTextFileSync(path).split('\n').entries()) {
        if (isComment(line)) continue;
        if (DIRECT_IMPORT.test(line)) offenders.push(`${relative(REPO_ROOT, path)}:${n + 1}: ${line.trim()}`);
      }
    }

    assertEquals(
      offenders,
      [],
      `import parseArgs from lib/args/mod.ts; @std/cli drops a value attached to a short option:\n  ${offenders.join('\n  ')}`,
    );
  });
});
