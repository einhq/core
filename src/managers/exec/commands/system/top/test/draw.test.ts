import { assertEquals } from '@std/assert';
import { cut } from '../../../../../shell/terminal/width.ts';
import { areaGraph, box, cutStart, fit, gauge, rowWidth, span, spread, toAnsi, toText } from '../draw.ts';

Deno.test('top drawing', async (t) => {
  await t.step('a row is padded to its width, or cut with an ellipsis at the edge', () => {
    assertEquals(toText(fit([span('ab'), span('c')], 5)), 'abc  ');
    assertEquals(toText(fit([span('abc'), span('def')], 5)), 'abcd…');
    // A span that reaches the edge with more after it ends in the ellipsis too.
    assertEquals(toText(fit([span('abcde'), span('f')], 5)), 'abcd…');
    assertEquals(toText(fit([span('abc')], 0)), '');
  });

  await t.step('wide characters count two columns and are never split', () => {
    const row = fit([span('日本語テキスト')], 6);
    assertEquals(rowWidth(row), 6);
    assertEquals(toText(row), '日本… ');
    assertEquals(cut('日本語', 4), '日…');
  });

  await t.step('a path is cut from its start, keeping its end', () => {
    assertEquals(cutStart('/archive/albums/garden/IMG_0042.jpg', 14), '…/IMG_0042.jpg');
    assertEquals(cutStart('short', 14), 'short');
  });

  await t.step('spread puts the right part against the edge and lets the left give way', () => {
    assertEquals(toText(spread([span('left')], [span('right')], 12)), 'left   right');
    assertEquals(toText(spread([span('a long left part')], [span('right')], 12)), 'a lon… right');
  });

  await t.step('a gauge fills in eighths of a column and keeps its width', () => {
    assertEquals(toText(gauge(0.5, 4, '')), '██░░');
    assertEquals(toText(gauge(1 / 16, 4, '')), '▎░░░');
    assertEquals(toText(gauge(2, 4, '')), '████');
    assertEquals(toText(gauge(Number.NaN, 4, '')), '░░░░');
  });

  await t.step('an area graph is drawn bottom up, newest at the right, a little above zero still seen', () => {
    const rows = areaGraph([0, 0.001, 0.5, 1], 6, 2, () => '');
    assertEquals(rows.map(toText), ['     █', '   ▁██']);
    // Older values than fit fall off the left.
    assertEquals(areaGraph([1, 0], 1, 1, () => '').map(toText), [' ']);
  });

  await t.step('an area graph colors each row by how high it is', () => {
    const styles = areaGraph([1], 1, 4, (fraction) => fraction > 0.5 ? 'hot' : 'cool').map((row) => row[0].style);
    assertEquals(styles, ['hot', 'hot', 'cool', 'cool']);
  });

  await t.step('a box is exactly its size, its labels on the frame where they fit', () => {
    const rows = box([span('CPU')], [span('42%')], [[span('inside')]], 20, 4, [span('note')]);
    assertEquals(rows.map(toText), [
      '╭─ CPU ────── 42% ─╮',
      '│ inside           │',
      '│                  │',
      '╰' + '─'.repeat(11) + ' note ─╯',
    ]);
    for (const width of [4, 5, 9, 13]) {
      for (const row of box([span('A long title')], [span('info')], [[span('content wider than any box')]], width, 3)) {
        assertEquals(rowWidth(row), width, `${width}: ${toText(row)}`);
      }
    }
  });

  await t.step('styles become SGR sequences, reset at the end of the row', () => {
    assertEquals(toAnsi([span('a', '1'), span('b', '1'), span('c')]), '\x1b[0;1mab\x1b[0mc');
    assertEquals(toAnsi([span('plain')]), 'plain');
  });
});
