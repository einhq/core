/** The validated, resolved response from `parse-search`: the installed parser's reading of a search's words. */

import { SEARCH_KINDS, type SearchFilters, type SearchKind, type SearchRegion, splitSubject, subjectArg } from './search-filters.ts';
import type { SearchParse, SearchSubjectMatch as NaturalSubjectMatch, SearchSubjectRef as NaturalSubjectRef } from '@ein/api';
export type { NaturalSubjectMatch, NaturalSubjectRef };

/**
 * `parse-search`'s answer (`SearchParse` in `@ein/api`), read loosely: kinds as plain strings the
 * search page narrows itself, and an explanation that may be absent from an older cached answer.
 */
export type NaturalQueryParse = Omit<SearchParse, 'kinds' | 'explain' | 'region'> & {
  kinds: string[];
  explain?: string;
  region?: SearchRegion;
};

const add = (left: string[] | undefined, right: string[]): string[] | undefined => {
  const merged = [...new Set([...(left ?? []), ...right])];
  return merged.length > 0 ? merged : undefined;
};

const yearOf = (bound: string | undefined): number | undefined => {
  const match = bound?.match(/^(1[89]\d{2}|20\d{2})/);
  return match ? Number(match[1]) : undefined;
};

/**
 * Apply a natural-language parse to filters already chosen in the UI.
 *
 * The caller supplies the explicit controls that should survive. A parsed media kind replaces
 * the segmented control; a name that is one subject becomes that subject, and any other name its
 * own intersected partial-name group. The UI exposes year granularity, so a finer parsed date
 * is rounded to its visible year rather than hiding precision in the URL.
 */
export const filtersFromNaturalQuery = (
  current: SearchFilters,
  parsed: NaturalQueryParse,
  allowedKinds: readonly SearchKind[] = SEARCH_KINDS,
): SearchFilters => {
  const kinds = parsed.kinds.filter((kind): kind is SearchKind => (SEARCH_KINDS as readonly string[]).includes(kind) && allowedKinds.includes(kind as SearchKind));
  const subjects = add(current.subjects, parsed.subjects.flatMap((subject) => subject.ref ? [subjectArg(subject.kind, subject.ref)] : []));
  const subjectNames = add(current.subjectNames, parsed.subjects.flatMap((subject) => subject.ref ? [] : [subjectArg(subject.kind, subject.name)]));
  const fromYear = yearOf(parsed.from);
  const toYear = yearOf(parsed.to);

  return {
    ...current,
    query: parsed.text.trim() || undefined,
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(subjects ? { subjects } : {}),
    ...(subjectNames ? { subjectNames } : {}),
    ...(fromYear !== undefined ? { fromYear } : {}),
    ...(toYear !== undefined ? { toYear } : {}),
    ...(parsed.region ? { region: parsed.region } : {}),
  };
};

export type SearchDetail = { label: string; value: string };

/** A subject's name for its ref, when the page has it. */
export type DetailNameOf = (kind: string, value: string) => string | undefined;

/**
 * Human-readable rows made from the filters that will actually be sent to `search`.
 *
 * The kind and the order are not among them: the page's own controls already show both. A slug
 * is named from the parse first, then from the page (`nameOf`), and shown as itself otherwise.
 */
export const naturalSearchDetails = (
  filters: SearchFilters,
  parsed?: NaturalQueryParse,
  nameOf?: DetailNameOf,
): SearchDetail[] => {
  const rows: SearchDetail[] = [];
  if (filters.like) rows.push({ label: 'Looks like (like)', value: filters.like });
  else rows.push({ label: 'Description (q)', value: filters.query?.trim() ? `“${filters.query.trim()}”` : 'none' });

  if (filters.subjectNames?.length) {
    const values = filters.subjectNames.map((subjectName) => {
      const { kind, ref: name } = splitSubject(subjectName);
      const words = name.trim().split(/\s+/).filter(Boolean);
      const explainedName = words.length > 1 ? `(${words.join(' AND ')})` : name;
      const matches = parsed?.subjects.find((subject) => subject.kind === kind && subject.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.matches ?? [];
      if (matches.length === 0) return `${explainedName} (partial name)`;
      return `${explainedName} → ${matches.map((match) => match.name).join(', ')}`;
    });
    rows.push({ label: 'Names (subject-name, AND words)', value: values.join(' AND ') });
  }
  if (filters.subjects?.length) {
    const subjectName = (subject: string) => {
      const { kind, ref } = splitSubject(subject);
      return parsed?.subjects.find((parsedSubject) => parsedSubject.kind === kind && parsedSubject.ref === ref)?.matches[0]?.name ?? (kind && nameOf?.(kind, ref)) ?? ref;
    };
    rows.push({ label: 'Exact (subject)', value: filters.subjects.map(subjectName).join(' AND ') });
  }
  if (filters.region) rows.push({ label: 'Area', value: filters.region.shape });

  if (filters.fromYear !== undefined || filters.toYear !== undefined) {
    const value = filters.fromYear === filters.toYear ? String(filters.fromYear) : `${filters.fromYear ?? 'earliest'} through ${filters.toYear ?? 'latest'}`;
    rows.push({ label: 'Date (from/to)', value });
  }

  if (filters.tags?.length) rows.push({ label: 'Labels (tag)', value: filters.tags.join(' AND ') });
  if (filters.under) rows.push({ label: 'Album/directory', value: filters.under });
  return rows;
};
