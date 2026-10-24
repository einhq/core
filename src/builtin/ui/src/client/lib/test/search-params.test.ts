/**
 * The search URL codec. Pure, so it is tested directly rather than through the page.
 *
 * The round trip is the contract: whatever the page puts in the address bar has to come back
 * as the same filters, or a shared link silently searches for something else than the person
 * who shared it saw.
 */

import { assertEquals } from '@std/assert';
import type { SearchFilters } from '../search-filters.ts';
import { filtersFromParams, paramsFromFilters } from '../search-params.ts';

const roundTrip = (filters: SearchFilters): SearchFilters => filtersFromParams(paramsFromFilters(filters));

Deno.test('every filter survives a round trip', () => {
  const filters: SearchFilters = {
    query: 'red boat',
    kinds: ['photo', 'video'],
    tags: ['holiday'],
    subjects: ['person:nils', 'person:maria', 'location:italy'],
    subjectNames: ['person:Nils', 'person:Anna, Lisa'],
    fromYear: 2011,
    toYear: 2014,
    sort: '-time',
  };

  assertEquals(roundTrip(filters), filters);
});

Deno.test('all three region shapes survive a round trip', () => {
  assertEquals(
    roundTrip({ region: { shape: 'circle', lat: 57.7, lng: 11.97, radius: 5000 } }),
    { region: { shape: 'circle', lat: 57.7, lng: 11.97, radius: 5000 } },
  );

  assertEquals(
    roundTrip({ region: { shape: 'bbox', north: 47.1, south: 35.4, east: 18.5, west: 6.6 } }),
    { region: { shape: 'bbox', north: 47.1, south: 35.4, east: 18.5, west: 6.6 } },
  );

  const points = [{ lat: 57.7, lng: 11.9 }, { lat: 57.8, lng: 12.0 }, { lat: 57.6, lng: 12.1 }];
  assertEquals(roundTrip({ region: { shape: 'polygon', points } }), { region: { shape: 'polygon', points } });
});

Deno.test('an empty filter set produces an empty URL', () => {
  assertEquals(paramsFromFilters({}).toString(), '');
  assertEquals(filtersFromParams(new URLSearchParams()), {});
});

Deno.test('parameters are named after the command flags', () => {
  const params = paramsFromFilters({ kinds: ['photo'], subjects: ['person:nils', 'person:maria'], subjectNames: ['person:Nils'], fromYear: 2011 });
  assertEquals(params.get('kind'), 'photo');
  assertEquals(params.getAll('subject'), ['person:nils', 'person:maria']);
  assertEquals(params.getAll('subject-name'), ['person:Nils']);
  assertEquals(params.get('from'), '2011');
});

Deno.test('extra parameters ride along without becoming filters', () => {
  // `order` changes which end of the answer is the top, not what matches — the
  // media page's reverse toggle.
  const params = paramsFromFilters({ kinds: ['photo'] }, { order: 'asc' });
  assertEquals(params.get('order'), 'asc');
  assertEquals(filtersFromParams(params), { kinds: ['photo'] });
});

Deno.test('a hand-mangled URL still searches on the parts that parse', () => {
  const params = new URLSearchParams({
    q: 'boat',
    kind: 'photo,unicorn',
    sort: 'sideways',
    from: 'nonsense',
    circle: '57.7,11.97', // a radius short
  });

  assertEquals(filtersFromParams(params), { query: 'boat', kinds: ['photo'] });
});

Deno.test('a polygon with fewer than three points is not a region', () => {
  const params = new URLSearchParams({ poly: '57.7,11.9;57.8,12.0' });
  assertEquals(filtersFromParams(params).region, undefined);
});

Deno.test('blank values leave no trace', () => {
  const params = paramsFromFilters({ query: '   ', kinds: [], subjects: [] }, { order: '' });
  assertEquals(params.toString(), '');
});

Deno.test('a picked device and album survive the address bar', () => {
  const filters = { subjects: ['device:/archive/devices/Camera_One'], under: '/archive/albums/Summer' };
  assertEquals(filtersFromParams(paramsFromFilters(filters)), filters);
});

Deno.test('a picture to look like survives the address bar, with the filters that narrow it', () => {
  const filters: SearchFilters = { like: '/archive/albums/Summer/files/IMG_0001.jpg', subjects: ['person:nils'], kinds: ['photo'] };
  assertEquals(paramsFromFilters(filters).get('like'), '/archive/albums/Summer/files/IMG_0001.jpg');
  assertEquals(roundTrip(filters), filters);
});
