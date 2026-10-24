import { assertEquals } from '@std/assert';
import { columnsMinWidth, columnTemplate, DEFAULT_COLUMN_WIDTHS, parseColumnWidths, withColumnWidth } from '../node-columns.ts';

Deno.test('node columns: the name takes what is left, the others their width', () => {
  assertEquals(columnTemplate([200, 100, 50]), 'minmax(200px, 1fr) 100px 50px');
  assertEquals(columnsMinWidth([200, 100, 50]), 350 + 2 * 12 + 12);
});

Deno.test('node columns: one column changes, bounded; anything but a full set is the default', () => {
  assertEquals(withColumnWidth([200, 100, 50], 1, 10), [200, 48, 50]);
  assertEquals(parseColumnWidths([1, 2, 3]), [...DEFAULT_COLUMN_WIDTHS]);
  assertEquals(parseColumnWidths(DEFAULT_COLUMN_WIDTHS.map((w) => w + 0.4)), [...DEFAULT_COLUMN_WIDTHS]);
});
