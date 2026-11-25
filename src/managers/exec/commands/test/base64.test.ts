/**
 * base64 command: encoding with and without wrapping, decoding as GNU base64 does, and binary
 * passing through a pipe and a redirect unchanged.
 */

import { assertEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { Base64Decoder, Base64Encoder } from '../utils/base64.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

Deno.test('Base64Encoder: groups split across chunks, wrapping across them', () => {
  const encoder = new Base64Encoder(4);
  assertEquals(encoder.push(bytes('he')) + encoder.push(bytes('llo')) + encoder.end(), 'aGVs\nbG8=\n');
  const unwrapped = new Base64Encoder(0);
  assertEquals(unwrapped.push(bytes('a')) + unwrapped.end(), 'YQ==');
  assertEquals(new Base64Encoder(76).end(), '');
});

Deno.test('Base64Decoder', () => {
  const decode = (chunks: string[], ignoreGarbage = false) => {
    const decoder = new Base64Decoder(ignoreGarbage);
    const out = chunks.map((chunk) => text(decoder.push(bytes(chunk)))).join('') + text(decoder.end());
    return { out, invalid: decoder.invalid };
  };
  assertEquals(decode(['aGV', 'sbG', '8=\n']), { out: 'hello', invalid: false });
  assertEquals(decode(['YQ==Yg==']), { out: 'ab', invalid: false });
  // An unpadded end and a stray character are invalid; what came before them is kept.
  assertEquals(decode(['YQ']), { out: 'a', invalid: true });
  assertEquals(decode(['YWJj', 'Y!Q==']), { out: 'abc', invalid: true });
  assertEquals(decode(['Y!Q==\n'], true), { out: 'a', invalid: false });
  assertEquals(decode(['Y']), { out: '', invalid: true });
  assertEquals(decode(['YQ=b']), { out: '', invalid: true });
});

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'base64 command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const run = async (line: string) => await client.execString(line, { json: false });

  try {
    await t.step('encode and decode stdin', async () => {
      assertEquals(await run(`echo hello | base64`), 'aGVsbG8K\n');
      assertEquals(await run(`echo aGVsbG8K | base64 -d`), 'hello\n');
      assertEquals(await run(`echo aGVsbG8K | base64 --decode`), 'hello\n');
      assertEquals(await run(`printf '' | base64`), '');
    });

    await t.step('wrap spellings: 76 by default, -w N, -wN, --wrap=N, -w 0 not at all', async () => {
      const long = await run(`seq -s x 40 | base64`);
      assertEquals(long.split('\n').map((line) => line.length), [76, 72, 0]);
      for (const flag of ['-w 4', '-w4', '--wrap=4']) {
        assertEquals(await run(`printf hello | base64 ${flag}`), 'aGVs\nbG8=\n', flag);
      }
      assertEquals(await run(`printf hello | base64 -w 0`), 'aGVsbG8=');
    });

    await t.step('text with quotes and newlines reaches a file intact', async () => {
      const content = `a 'quoted' "line"\nand $HOME \\ another\n`;
      const encoded = btoa(content);
      await run(`mkdir -p /tmp/base64-test && echo ${encoded} | base64 -d > /tmp/base64-test/a.txt`);
      assertEquals(await run(`cat /tmp/base64-test/a.txt`), content);
      assertEquals(await run(`base64 -w0 /tmp/base64-test/a.txt`), encoded);
    });

    await t.step('binary passes through a pipe and a redirect unchanged', async () => {
      // Every byte value, which is not valid UTF-8.
      const all = new Uint8Array(256).map((_, i) => i);
      const encoded = btoa(String.fromCharCode(...all));
      assertEquals(await run(`echo ${encoded} | base64 -d | base64 -w 0`), encoded);
      await run(`echo ${encoded} | base64 -d > /tmp/base64-test/all.bin`);
      assertEquals(await run(`wc -c < /tmp/base64-test/all.bin`), '256\n');
      assertEquals(decodeBase64((await run(`base64 /tmp/base64-test/all.bin`)).replaceAll('\n', '')), all);
      assertEquals(await run(`base64 -w0 - < /tmp/base64-test/all.bin`), encoded);
    });

    await t.step('-i drops what is not of the alphabet', async () => {
      assertEquals(await run(`echo 'aGVs bG8K!' | base64 -di`), 'hello\n');
    });

    await t.step('bad input, a bad width, an extra operand and a missing file fail', async () => {
      const cmd = testCommands(client);
      await cmd.shouldFailWith(`echo 'aGVs bG8K' | base64 -d`, 'invalid input');
      await cmd.shouldFailWith(`echo x | base64 -w x`, 'invalid wrap size');
      await cmd.shouldFailWith(`echo x | base64 --wrap=-1`, 'invalid wrap size');
      await cmd.shouldFailWith(`base64 /tmp/base64-test/a.txt /tmp/base64-test/a.txt`, 'extra operand');
      await cmd.shouldFailWith(`base64 /tmp/base64-test/missing`, 'missing');
      await cmd.shouldFailWith(`echo x | base64 -z`, 'unknown flag');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
