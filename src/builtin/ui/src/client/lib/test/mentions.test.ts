/**
 * The `@`-mention codec: what the box holds, what it commits to, and what a
 * shared link puts back in it.
 */

import { assertEquals } from '@std/assert';
import { applyCompletion, filtersFromMentions, type Mention, mentionAtCaret, parseMentions, textFromFilters } from '../mentions.ts';

const nils: Mention = { kind: 'person', label: 'Nils J Lund-Berg', value: 'Nils_J_Lund' };
const anna: Mention = { kind: 'person', label: 'Anna', value: 'anna' };
const italy: Mention = { kind: 'location', label: 'Italy', value: 'italy' };
const beach: Mention = { kind: 'label', label: 'beach', value: 'beach' };

Deno.test('mentions: a mention with spaces is lifted out whole', () => {
  const parsed = parseMentions('sunglasses @Nils J Lund-Berg', [nils]);
  assertEquals(parsed.query, 'sunglasses');
  assertEquals(parsed.mentions, [nils]);
  assertEquals(parsed.unresolved, []);
});

Deno.test('mentions: the longest label wins, so a first name does not eat a full one', () => {
  // Both are known and both would match "@Anna" — only the full label may claim
  // the surname that follows it.
  const parsed = parseMentions('@Anna Lindberg', [anna, { kind: 'person', label: 'Anna Lindberg', value: 'anna_lindberg' }]);
  assertEquals(parsed.query, '');
  assertEquals(parsed.mentions.map((m) => m.value), ['anna_lindberg']);
});

Deno.test('mentions: several mentions keep the order they were typed in', () => {
  const parsed = parseMentions('@Italy boats @Anna', [anna, italy]);
  assertEquals(parsed.query, 'boats');
  assertEquals(parsed.mentions, [italy, anna]);
});

Deno.test('mentions: an unknown @run stays in the query and is reported', () => {
  const parsed = parseMentions('boats @Nobody @Anna', [anna]);
  // Still searched for as text — pretending it was understood would show a
  // narrower result set than was asked for, with no sign of why.
  assertEquals(parsed.query, 'boats @Nobody');
  assertEquals(parsed.unresolved, ['Nobody']);
  assertEquals(parsed.mentions, [anna]);
});

Deno.test('mentions: matching ignores case, since the label is retyped by hand', () => {
  assertEquals(parseMentions('@anna', [anna]).mentions, [anna]);
});

Deno.test('mentions: filters merge into what is already there, deduplicated', () => {
  const parsed = parseMentions('@Anna @beach', [anna, beach]);
  const filters = filtersFromMentions({ subjects: ['person:bo'], kinds: ['photo'] }, parsed);
  assertEquals(filters.subjects, ['person:bo', 'person:anna']);
  assertEquals(filters.tags, ['beach']);
  // Untouched: a mention refines the controls rather than resetting them.
  assertEquals(filters.kinds, ['photo']);
});

Deno.test('mentions: a repeated person is one filter, not two', () => {
  const parsed = parseMentions('@Anna and @Anna', [anna]);
  assertEquals(filtersFromMentions({}, parsed).subjects, ['person:anna']);
});

Deno.test('mentions: a shared link puts the labels back in the box', () => {
  const names: Record<string, string> = { Nils_J_Lund: 'Nils J Lund-Berg', italy: 'Italy' };
  const { text, mentions } = textFromFilters(
    { query: 'sunglasses', subjects: ['person:Nils_J_Lund', 'location:italy'] },
    (_kind, value) => names[value],
  );
  assertEquals(text, 'sunglasses @Nils J Lund-Berg @Italy');
  // And it round-trips: re-parsing that box yields the filters it came from.
  const parsed = parseMentions(text, mentions);
  assertEquals(parsed.query, 'sunglasses');
  assertEquals(filtersFromMentions({}, parsed).subjects, ['person:Nils_J_Lund', 'location:italy']);
});

Deno.test('mentions: a value with no name is dropped rather than shown as a slug', () => {
  // A raw slug in the box would not re-parse to the filter it came from, so it
  // would silently drop on the next commit.
  const { text, mentions } = textFromFilters({ subjects: ['person:ghost'] }, () => undefined);
  assertEquals(text, '');
  assertEquals(mentions, []);
});

Deno.test('mentions: the caret run is what the popup completes on', () => {
  assertEquals(mentionAtCaret('boats @Ma', 9), { query: 'Ma', start: 6 });
  // A label has spaces, so the run does not end at one.
  assertEquals(mentionAtCaret('@Nils J', 7), { query: 'Nils J', start: 0 });
  assertEquals(mentionAtCaret('boats', 5), undefined);
  // An email is not a mention.
  assertEquals(mentionAtCaret('nils@strand.se', 14), undefined);
  // Punctuation that never appears in a name ends the run.
  assertEquals(mentionAtCaret('@Anna, and', 10), undefined);
});

Deno.test('mentions: completing replaces the run and leaves the caret after it', () => {
  const result = applyCompletion('boats @Ma', 9, { start: 6 }, nils);
  assertEquals(result.text, 'boats @Nils J Lund-Berg ');
  assertEquals(result.caret, result.text.length);
});
