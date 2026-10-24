/**
 * Arrays and IFS field splitting through the real shell: iterating over `find` output keeps a
 * path with a blank in it whole. The end-to-end check, since EiN is where the linked parser and
 * executor run together.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'arrays and IFS',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('an array keeps one element per word', async () => {
      const out = await client.execString('a=(x "b c" d); echo "${#a[@]}"; for e in "${a[@]}"; do echo "[$e]"; done');
      assertEquals(out.trim().split('\n'), ['3', '[x]', '[b c]', '[d]']);
    });

    await t.step('IFS decides what an expansion splits on', async () => {
      const out = await client.execString('IFS=:; V="a:b c"; for e in $V; do echo "[$e]"; done');
      assertEquals(out.trim().split('\n'), ['[a]', '[b c]']);
    });

    await t.step('find output with blanks in the names survives', async () => {
      await client.exec('mkdir /spaced');
      await client.exec('mkfile "/spaced/one file.txt"');
      await client.exec('mkfile "/spaced/two file.txt"');

      // JSON_OUTPUT=0 because the API shell this client speaks to runs every
      // command in JSON mode, where find emits one JSON array rather than lines
      const script = [
        "IFS=$'\\n'",
        'FILES=($(JSON_OUTPUT=0 find /spaced -type f))',
        'unset IFS',
        'echo "${#FILES[@]}"',
        'for f in "${FILES[@]}"; do echo "[$f]"; done',
      ].join('; ');

      const out = await client.execString(script);
      const lines = out.trim().split('\n');

      assertEquals(lines[0], '2');
      assertEquals(lines.slice(1).sort(), ['[/spaced/one file.txt]', '[/spaced/two file.txt]']);
    });

    await t.step('a here-string feeds a command its stdin', async () => {
      const out = await client.execString('read -a parts <<< "a b c"; echo "${#parts[@]} ${parts[2]}"');
      assertEquals(out.trim(), '3 c');
    });

    await t.step('a heredoc writes its body to a file, parentheses and Markdown included', async () => {
      // An array assignment written across lines, with a `(` in the first.
      const script = "cat > /heredoc.md << 'EOF'\n# Family\n- **Anna Exempel** (mother)\n  Born: 1950-01-01\nEOF\nNAME=Bo\ncat <<EOF\nhi $NAME (x)\nEOF";
      assertEquals((await client.execString(script)).trim(), 'hi Bo (x)');
      assertEquals(await client.execString('cat /heredoc.md'), '# Family\n- **Anna Exempel** (mother)\n  Born: 1950-01-01\n');
    });

    await t.step('process substitution gives a path the command can read', async () => {
      const out = await client.execString('mapfile -t L < <(printf "one file\ntwo file\n"); echo "${#L[@]}"; echo "[${L[1]}]"');
      assertEquals(out.trim().split('\n'), ['2', '[two file]']);
    });

    await t.step('a backslash in double quotes stays a backslash', async () => {
      const out = await client.execString('echo "a\\nb"');
      assertEquals(out.trim(), 'a\\nb');
    });

    await t.step('an associative array keys on strings', async () => {
      const out = await client.execString('declare -A m; m[one]=1; m["two words"]=2; echo "${m[one]}${m[two words]} ${#m[@]}"');
      assertEquals(out.trim(), '12 2');
    });

    await t.step('a flag array reaches the command as separate arguments', async () => {
      // A script passing its own flags through to another command
      const out = await client.execString('FLAGS=(); FLAGS+=(-n); FLAGS+=(2); seq 5 | head "${FLAGS[@]}"');
      assertEquals(out.trim().split('\n'), ['1', '2']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
