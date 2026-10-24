import { assertEquals } from '@std/assert';
import { forgetSearch, RECENT_SEARCHES, recentSearchesFrom, rememberSearch } from '../recent-searches.ts';

const boat = { params: 'q=boat', label: 'boat' };
const snow = { params: 'q=snow', label: 'snow' };

Deno.test('the newest search comes first, and a repeat moves up instead of doubling', () => {
  const list = rememberSearch(rememberSearch([], boat), snow);
  assertEquals(list, [snow, boat]);
  assertEquals(rememberSearch(list, { ...boat, label: 'boat @Anna Andersson' }), [{ ...boat, label: 'boat @Anna Andersson' }, snow]);
});

Deno.test('the list is capped, and a search with nothing to name is not kept', () => {
  let list = [boat];
  for (let i = 0; i < RECENT_SEARCHES + 3; i++) list = rememberSearch(list, { params: `q=${i}`, label: String(i) });
  assertEquals(list.length, RECENT_SEARCHES);
  assertEquals(rememberSearch([boat], { params: 'q=', label: ' ' }), [boat]);
});

Deno.test('forgetting one search, and reading back what storage held', () => {
  assertEquals(forgetSearch([boat, snow], 'q=boat'), [snow]);
  assertEquals(recentSearchesFrom([boat, { params: 3 }, 'x', null, snow]), [boat, snow]);
  assertEquals(recentSearchesFrom('not a list'), []);
});
