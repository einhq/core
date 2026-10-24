/**
 * The search page's URL, as a codec.
 *
 * The address bar is the search page's only state. That is what makes a search linkable,
 * bookmarkable and survivable across a reload, a region-filtered one included.
 *
 * Parameters are named after the `search` command's own flags, so what is in the URL and
 * what goes over the wire read the same. The three region forms stay separate parameters,
 * exactly as the command keeps `--bbox`, `--circle` and `--polygon` separate and mutually
 * exclusive, rather than being packed into one opaque value.
 *
 * Pure on purpose: no react-router, no shell client. Everything here is a round-trip that
 * can be tested directly.
 */

import { SEARCH_KINDS, SEARCH_SORTS, type SearchFilters, type SearchKind, type SearchRegion, type SearchSort } from './search-filters.ts';

const csv = (value: string | null): string[] => (value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []);

const numbers = (value: string, count: number): number[] | undefined => {
  const parts = value.split(',').map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : undefined;
};

/** A year bound. Only the year form is used by the UI; the command accepts finer ones. */
const year = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const parsed = Number(value.slice(0, 4));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const regionFromParams = (params: URLSearchParams): SearchRegion | undefined => {
  const circle = params.get('circle');
  if (circle) {
    const parsed = numbers(circle, 3);
    if (parsed) return { shape: 'circle', lat: parsed[0], lng: parsed[1], radius: parsed[2] };
  }

  const bbox = params.get('bbox');
  if (bbox) {
    const parsed = numbers(bbox, 4);
    if (parsed) return { shape: 'bbox', north: parsed[0], south: parsed[1], east: parsed[2], west: parsed[3] };
  }

  const poly = params.get('poly');
  if (poly) {
    const points = poly.split(';').map((pair) => numbers(pair, 2)).filter((p): p is number[] => p !== undefined)
      .map(([lat, lng]) => ({ lat, lng }));
    if (points.length >= 3) return { shape: 'polygon', points };
  }

  return undefined;
};

const regionToParams = (params: URLSearchParams, region: SearchRegion): void => {
  if (region.shape === 'circle') params.set('circle', `${region.lat},${region.lng},${Math.round(region.radius)}`);
  else if (region.shape === 'bbox') params.set('bbox', `${region.north},${region.south},${region.east},${region.west}`);
  else params.set('poly', region.points.map((p) => `${p.lat},${p.lng}`).join(';'));
};

/**
 * Read filters out of the address bar.
 *
 * Anything malformed is ignored rather than rejected: a URL is user-editable and arrives
 * hand-mangled often enough that a half-valid one should still search.
 */
export const filtersFromParams = (params: URLSearchParams): SearchFilters => {
  const kinds = csv(params.get('kind')).filter((kind): kind is SearchKind => (SEARCH_KINDS as readonly string[]).includes(kind));
  const sortRaw = params.get('sort') as SearchSort | null;
  const sort = sortRaw && SEARCH_SORTS.includes(sortRaw) ? sortRaw : undefined;

  const query = params.get('q')?.trim();
  // Repeated rather than comma-joined: a subject's ref is a path or a name, and may hold a comma.
  const subjects = params.getAll('subject').map((subject) => subject.trim()).filter(Boolean);
  const subjectNames = params.getAll('subject-name').map((name) => name.trim()).filter(Boolean);
  const tags = csv(params.get('tag'));
  const under = params.get('under')?.trim();
  const like = params.get('like')?.trim();

  return {
    ...(query ? { query } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(subjects.length > 0 ? { subjects } : {}),
    ...(subjectNames.length > 0 ? { subjectNames } : {}),
    ...(year(params.get('from')) !== undefined ? { fromYear: year(params.get('from')) } : {}),
    ...(year(params.get('to')) !== undefined ? { toYear: year(params.get('to')) } : {}),
    ...(regionFromParams(params) ? { region: regionFromParams(params) } : {}),
    ...(under ? { under } : {}),
    ...(like ? { like } : {}),
    ...(sort ? { sort } : {}),
  };
};

/**
 * Write filters into an address bar.
 *
 * `extra` carries non-filter parameters that ride along with them. Empty values
 * are omitted entirely so a cleared filter leaves no trace in the URL.
 */
export const paramsFromFilters = (filters: SearchFilters, extra: Record<string, string | undefined> = {}): URLSearchParams => {
  const params = new URLSearchParams();

  if (filters.query?.trim()) params.set('q', filters.query.trim());
  if (filters.kinds?.length) params.set('kind', filters.kinds.join(','));
  if (filters.tags?.length) params.set('tag', filters.tags.join(','));
  for (const subject of filters.subjects ?? []) if (subject.trim()) params.append('subject', subject.trim());
  for (const name of filters.subjectNames ?? []) if (name.trim()) params.append('subject-name', name.trim());
  if (filters.fromYear !== undefined) params.set('from', String(filters.fromYear));
  if (filters.toYear !== undefined) params.set('to', String(filters.toYear));
  if (filters.region) regionToParams(params, filters.region);
  // An `@` pick of an album, kept in the URL like the rest.
  if (filters.under) params.set('under', filters.under);
  if (filters.like) params.set('like', filters.like);
  if (filters.sort) params.set('sort', filters.sort);

  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }

  return params;
};
