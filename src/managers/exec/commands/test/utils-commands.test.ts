/**
 * Utility command coverage — the commands pipeline filter/skipIf/condition
 * scripts and module scripts depend on: jq, grep, head, tail, wc, seq,
 * uuid, date, env, plus mount listing and its admin gate.
 */

import { assertEquals, assertMatch } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'utility commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('seq generates sequences', async () => {
      const out = await client.execString('seq 3');
      assertEquals(out.trim().split('\n'), ['1', '2', '3']);
    });

    await t.step('wc -l counts lines in a pipe', async () => {
      const out = await client.execString('seq 5 | wc -l');
      assertEquals(out.trim(), '5');
    });

    await t.step('single quotes are literal like bash', async () => {
      // Backslash sequences inside single quotes must reach the command verbatim
      // (e.g. sed backreferences \1, not octal control chars).
      assertEquals(
        (await client.execString(String.raw`echo 's/(a)/\1/'`)).trim(),
        String.raw`s/(a)/\1/`,
      );
      assertEquals(
        (await client.execString(String.raw`echo 'a\n b\t'`)).trim(),
        String.raw`a\n b\t`,
      );
    });

    await t.step('head and tail slice pipes', async () => {
      assertEquals((await client.execString('seq 5 | head -n 2')).trim().split('\n'), ['1', '2']);
      assertEquals((await client.execString('seq 5 | tail -n 2')).trim().split('\n'), ['4', '5']);
    });

    await t.step('grep filters lines', async () => {
      const out = await client.execString('seq 20 | grep 1 | wc -l');
      // 1, 10-19 => 11 lines containing "1"
      assertEquals(out.trim(), '11');
    });

    await t.step('grep reads a log node and exits instead of following it', async () => {
      await cmd.shouldSucceed('mknode -t log /greplog');
      await cmd.shouldSucceed(`log-append /greplog --data '{"value":10}'`);
      await cmd.shouldSucceed(`log-append /greplog --data '{"value":20}'`);
      assertEquals((await client.execString('grep 20 /greplog')).trim(), '{"value":20}');
    });

    await t.step('jq extracts fields from attrs output', async () => {
      await client.exec('mkfile /jq-test.txt');
      const out = await client.execString('JSON_OUTPUT=1 attrs /jq-test.txt | jq .mimetype');
      assertEquals(out.trim().replaceAll('"', ''), 'text/plain');
    });

    await t.step('jq -e sets exit code on match', async () => {
      await cmd.shouldSucceed(`JSON_OUTPUT=1 attrs /jq-test.txt | jq -e '.mimetype | startswith("text/")'`);
      await cmd.shouldFail(`JSON_OUTPUT=1 attrs /jq-test.txt | jq -e '.mimetype | startswith("image/")'`);
    });

    await t.step('jq iterates with .[], one output per element', async () => {
      const list = `echo '[{"name":"a","tags":["x"]},{"name":"b","tags":["y","z"]}]'`;
      for (const filter of ['.[].name', '.[] | .name', '.[]? | .name']) {
        assertEquals(await client.execString(`${list} | jq -r '${filter}'`), 'a\nb\n');
      }
      assertEquals(await client.execString(`${list} | jq -r '.[].tags[]'`), 'x\ny\nz\n');
      assertEquals((await client.execString(`${list} | jq -c 'map(.name)'`)).trim(), '["a","b"]');
      assertEquals(await client.execString(`echo '{"a":1,"b":2}' | jq '.[]'`), '1\n2\n');
      assertEquals(await client.execString(`echo '[null,1]' | jq '.[]'`), 'null\n1\n');
      assertEquals(await client.execString(`echo '[{"b":"y"},{"a":"x"}]' | jq -r '.[] | .a // .b'`), 'y\nx\n');
      assertEquals((await client.execString(`echo '1' | jq '.[]?' | wc -l`)).trim(), '0');
      await cmd.shouldFailWith(`echo '1' | jq '.[]'`, 'jq: cannot iterate over number');
      await cmd.shouldFail(`echo '[]' | jq -e '.[]'`);
    });

    await t.step('jq filters each JSON text of a stream, as in JSON Lines', async () => {
      const lines = `printf '{"a":1}\\n{"a":2}\\n\\n[3] "x" 4\\n'`;
      assertEquals(await client.execString(`${lines} | jq -c .`), '{"a":1}\n{"a":2}\n[3]\n"x"\n4\n');
      assertEquals(await client.execString(`${lines} | jq -c`), '{"a":1}\n{"a":2}\n[3]\n"x"\n4\n');
      assertEquals(await client.execString(`printf '{"a":1}{"a":"}{"}' | jq -r .a`), '1\n}{\n');
      await cmd.shouldFailWith(`printf '{"a":1}\\n{"a":}\\n' | jq .a`, 'in the JSON text at line 2');
    });

    await t.step('jq names a flag it does not implement instead of reading stdin', async () => {
      // A real-jq flag this subset lacks is refused before stdin is read: parseArgs would take
      // the argument after it as its value and leave a non-filter in the filter's location, and
      // stdin in the API shell never ends. No pipe here on purpose: the failure has to come
      // before the read, not from an empty one.
      await cmd.shouldFailWith(
        `jq -n --arg path /a/b.avif --argjson size 1 '{versionPath: $path, size: $size}'`,
        'jq: unknown flag -n --arg --argjson',
      );
    });

    await t.step('uuid produces unique values', async () => {
      const a = (await client.execString('uuid')).trim();
      const b = (await client.execString('uuid')).trim();
      assertEquals(a === b, false);
      assertEquals(a.length > 10, true);
    });

    await t.step('date outputs a timestamp', async () => {
      const out = (await client.execString('date')).trim();
      assertMatch(out, /\d{4}/);
    });

    await t.step('env reflects exported variables within a script', async () => {
      const out = await client.execString('export FOO=bar && env');
      assertEquals(out.includes('FOO=bar'), true);
    });

    await t.step('mount lists mounts for admin', async () => {
      const out = await client.exec('mount');
      assertEquals(out.success, true);
    });

    await t.step('mount is denied for non-admin', async () => {
      await cmd.shouldSucceed('user-create mallory');
      await cmd.shouldSucceed('user-passwd mallory --new-password pw123');

      const mallory = await testCtx.server.createShellClient({ username: 'mallory', password: 'pw123' });
      try {
        await mallory.exec('mknode -t directory /home/mallory/mnt');
        const result = await mallory.exec('mount /home/mallory/mnt memory');
        assertEquals(result.success, false);
      } finally {
        mallory.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
