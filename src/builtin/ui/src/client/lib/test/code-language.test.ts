import { assertEquals } from '@std/assert';
import { isTextLike, languageFor } from '../code-language.ts';

Deno.test('code language: mimetype decides first', () => {
  assertEquals(languageFor('application/json', 'x.txt'), 'json');
  assertEquals(languageFor('text/x-shellscript', 'run'), 'shell');
  assertEquals(languageFor('application/x-sh'), 'shell');
  assertEquals(languageFor('text/typescript'), 'typescript');
  assertEquals(languageFor('text/markdown; charset=utf-8'), 'markdown');
  assertEquals(languageFor('APPLICATION/JSON'), 'json');
});

Deno.test('code language: extension when the mimetype says nothing', () => {
  assertEquals(languageFor('text/plain', 'deno.jsonc'), 'json');
  assertEquals(languageFor(undefined, 'README.md'), 'markdown');
  assertEquals(languageFor('application/octet-stream', 'mod.ts'), 'typescript');
  assertEquals(languageFor('text/plain', 'notes'), 'text');
  assertEquals(languageFor(undefined, '.env'), 'text');
  assertEquals(languageFor(undefined, undefined), 'text');
});

Deno.test('code language: what the editor opens', () => {
  assertEquals(isTextLike('text/plain', 'anything'), true);
  assertEquals(isTextLike('text/x-shellscript'), true);
  assertEquals(isTextLike('application/json'), true);
  assertEquals(isTextLike('application/octet-stream', 'config.yml'), true);
  assertEquals(isTextLike(undefined, 'notes.txt'), true);
  assertEquals(isTextLike('application/octet-stream', 'blob.bin'), false);
  assertEquals(isTextLike(undefined, 'noext'), false);
  assertEquals(isTextLike('application/pdf', 'a.pdf'), false);
  assertEquals(isTextLike('image/jpeg', 'a.jpg'), false);
});
