import { assertEquals } from '@std/assert';
import { plainMarkdown } from '../markdown-plain.ts';

Deno.test('plainMarkdown', async (t) => {
  await t.step('inline marks and links leave their text', () => {
    assertEquals(plainMarkdown('A **bold** and _quiet_ day with `code`, ~~gone~~ and [a link](https://example.com)'), 'A bold and quiet day with code, gone and a link');
  });

  await t.step('block markers come off each line, and the lines stay', () => {
    assertEquals(plainMarkdown('## Summer\n> Said once\n- first\n2. second\n- [x] done'), 'Summer\nSaid once\nfirst\nsecond\ndone');
  });

  await t.step('a legacy <br> is a line break', () => {
    assertEquals(plainMarkdown('One<br>Two<br />Three'), 'One\nTwo\nThree');
  });

  await t.step('underscores inside words and plain text stay as they are', () => {
    assertEquals(plainMarkdown('file_name_here costs 5 * 3'), 'file_name_here costs 5 * 3');
  });
});
