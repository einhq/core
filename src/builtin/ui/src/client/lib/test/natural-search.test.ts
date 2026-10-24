import { assertEquals } from '@std/assert';
import { filtersFromNaturalQuery, type NaturalQueryParse, naturalSearchDetails } from '../natural-search.ts';

const parsed = (changes: Partial<NaturalQueryParse>): NaturalQueryParse => ({
  text: '',
  kinds: [],
  subjects: [],
  unresolved: [],
  source: 'llm',
  ...changes,
});

Deno.test('natural search keeps only semantic text and lifts partial person names into filters', () => {
  const filters = filtersFromNaturalQuery(
    { subjects: ['person:already-there'], kinds: ['video'] },
    parsed({
      text: 'red sailing boat',
      kinds: ['photo'],
      from: '2011-06-03',
      to: '2012-08',
      subjects: [
        { kind: 'person', name: 'Anna', matches: [{ name: 'Anna A', ref: 'anna-a' }, { name: 'Anna B', ref: 'anna-b' }] },
        { kind: 'location', name: 'Göteborg', ref: 'goteborg', matches: [{ name: 'Göteborg', ref: 'goteborg' }] },
      ],
    }),
    ['photo', 'video', 'audio', 'document'],
  );

  assertEquals(filters, {
    query: 'red sailing boat',
    kinds: ['photo'],
    subjects: ['person:already-there', 'location:goteborg'],
    subjectNames: ['person:Anna'],
    fromYear: 2011,
    toYear: 2012,
  });
});

const ANNA = { kind: 'person', name: 'Anna Andersson', ref: 'anna-andersson', matches: [{ name: 'Anna M Andersson', ref: 'anna-andersson' }] };

Deno.test('a name that is one person becomes that person, not a partial name', () => {
  assertEquals(
    filtersFromNaturalQuery({}, parsed({ subjects: [ANNA] })),
    { query: undefined, subjects: ['person:anna-andersson'] },
  );
  assertEquals(
    naturalSearchDetails({ subjects: ['person:anna-andersson'] }, parsed({ subjects: [ANNA] }))[1],
    { label: 'Exact (subject)', value: 'Anna M Andersson' },
  );
});

Deno.test('interpreted details show the partial-name expansion and actual semantic query', () => {
  assertEquals(
    naturalSearchDetails(
      { query: 'seglar', subjectNames: ['person:Nils'], fromYear: 2011, toYear: 2011, kinds: ['photo'] },
      parsed({ subjects: [{ kind: 'person', name: 'Nils', matches: [{ name: 'Nils A', ref: 'a' }, { name: 'Nils B', ref: 'b' }] }] }),
    ),
    [
      { label: 'Description (q)', value: '“seglar”' },
      { label: 'Names (subject-name, AND words)', value: 'Nils → Nils A, Nils B' },
      { label: 'Date (from/to)', value: '2011' },
    ],
  );
});

Deno.test('interpreted details name a slug from the page when the parse does not', () => {
  const nameOf = (kind: string, value: string) =>
    kind === 'person' && value === 'anna-a' ? 'Anna Andersson' : kind === 'location' && value === 'park' ? 'The Park' : undefined;
  assertEquals(naturalSearchDetails({ subjects: ['person:anna-a', 'person:bo', 'location:park'] }, undefined, nameOf).slice(1), [
    { label: 'Exact (subject)', value: 'Anna Andersson AND bo AND The Park' },
  ]);
});

Deno.test('interpreted details explain AND matching within a partial person name', () => {
  assertEquals(
    naturalSearchDetails(
      { subjectNames: ['person:Nils Lund'] },
      parsed({ subjects: [{ kind: 'person', name: 'Nils Lund', matches: [{ name: 'Nils J Lund-Berg', ref: 'nils' }] }] }),
    )[1],
    { label: 'Names (subject-name, AND words)', value: '(Nils AND Lund) → Nils J Lund-Berg' },
  );
});

Deno.test('natural search never puts an entity kind into the media kind control', () => {
  assertEquals(
    filtersFromNaturalQuery({ kinds: ['video'] }, parsed({ text: 'portrait', kinds: ['person'] }), ['photo', 'video']),
    { query: 'portrait', kinds: ['video'] },
  );
});

Deno.test('natural search applies a geocoded location as the visible region filter', () => {
  const region = { shape: 'bbox' as const, north: 47, south: 35, east: 19, west: 6 };
  assertEquals(filtersFromNaturalQuery({}, parsed({ region })), { query: undefined, region });
});
