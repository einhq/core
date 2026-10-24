import { assertEquals } from '@std/assert';
import { check } from '../check.ts';

Deno.test('check', async (t) => {
  await t.step('valid texts and unchecked languages have no problems', async () => {
    assertEquals(await check('json', '{"a": [1, 2]}'), []);
    assertEquals(await check('json', ''), []);
    assertEquals(await check('jsonc', '{\n  // a comment\n  "a": 1,\n}'), []);
    assertEquals(await check('yaml', 'a: 1\nb:\n  - x\n'), []);
    assertEquals(await check('bash', 'if true; then\n  echo "$x"\nfi\n'), []);
    assertEquals(await check('python', 'def ('), []);
    assertEquals(await check(undefined, '{'), []);
  });

  await t.step('JSON errors at the position V8 names', async () => {
    assertEquals(await check('json', '{"a": 1,}'), [{ line: 1, col: 9, message: 'expected double-quoted property name' }]);
    assertEquals(await check('json', '{"a": 1 // c\n}'), [{ line: 1, col: 9, message: "expected ',' or '}' after property value" }]);
  });

  await t.step('JSON errors V8 gives no position for are located by the JSONC parser', async () => {
    assertEquals(await check('json', '{\n "a": tru\n}'), [{ line: 2, col: 7, message: 'unexpected token "tru"' }]);
    assertEquals(await check('json', '{\n "a": [1,\n'), [{ line: 2, message: 'unexpected end of input' }]);
  });

  await t.step('YAML errors with their line and column, without the snippet', async () => {
    assertEquals(await check('yaml', 'a:\n  - b\n c: 1\n'), [{ line: 3, col: 2, message: 'bad indentation of a mapping entry' }]);
    assertEquals(await check('yaml', 'a: 1\na: 2\n'), [{ line: 2, col: 1, message: 'duplicated key' }]);
  });

  await t.step('bash errors say what bash would', async () => {
    assertEquals(await check('bash', 'if true; then\n  echo "hi\nfi\n'), [{ line: 2, col: 8, message: 'unclosed "' }]);
    assertEquals(await check('bash', 'echo a\nfoo )\n'), [{ line: 2, col: undefined, message: "unexpected token ')'" }]);
    assertEquals(await check('bash', 'if true; then\n echo x\n'), [{ line: 2, col: undefined, message: 'unexpected end of file' }]);
    assertEquals(await check('bash', 'echo a\ncat <<EOF\nabc\n'), [{ line: 2, message: "here-document not closed (wanted 'EOF')" }]);
  });

  await t.step('Markdown is checked fence by fence, at the lines of the document', async () => {
    const text = [
      '# Notes',
      '',
      '```json',
      '{"a": }',
      '```',
      '',
      '```sh',
      'if x; then',
      '```',
      '',
      '```python',
      'def (',
      '```',
    ].join('\n');
    assertEquals(await check('markdown', text), [
      { line: 4, col: 7, message: 'unexpected token "}"' },
      { line: 8, col: undefined, message: 'unexpected end of file' },
    ]);
  });
});
