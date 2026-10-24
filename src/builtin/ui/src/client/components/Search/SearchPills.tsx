import { Pill } from '@mantine/core';
import { TAGS_ROOT, TEMP_PATH } from '@ein/paths';
import { gridUrl } from '../../lib/derivatives.ts';
import { fileUrl } from '../../lib/file-url.ts';
import { type SearchFilters, splitSubject } from '../../lib/search-filters.ts';

/** What a pill needs a name for: a subject's kind (`person`, `location`, `device`), or `album`. */
export type PillKind = string;

export type SearchPillsProps = {
  filters: SearchFilters;
  /** Remove one filter: the changes to apply. */
  onPatch: (changes: Partial<SearchFilters>) => void;
  /** The name to show for a slug or a path, when the page knows it. */
  nameOf: (kind: PillKind, value: string) => string | undefined;
};

/** True when `SearchPills` has anything to show for these filters. */
export const hasPills = (filters: SearchFilters): boolean =>
  Boolean(
    filters.subjects?.length || filters.subjectNames?.length || filters.region || filters.tags?.length || filters.under || filters.like ||
      filters.fromYear !== undefined || filters.toYear !== undefined,
  );

const without = (list: string[] | undefined, value: string): string[] | undefined => {
  const rest = (list ?? []).filter((entry) => entry !== value);
  return rest.length > 0 ? rest : undefined;
};

const years = (from: number | undefined, to: number | undefined): string =>
  from !== undefined && to !== undefined ? (from === to ? String(from) : `${from}–${to}`) : from !== undefined ? `from ${from}` : `up to ${to}`;

const lastPart = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

/** A picture's tile: its grid rendition, or the file itself for one put in /tmp, which has none. */
const pictureUrl = (path: string): string => gridUrl(path, !path.startsWith(`${TEMP_PATH}/`));

/**
 * Every filter the search box produced, as a chip with its own remove button.
 *
 * The same chips for an `@` pick and for what `parse-search` read from the words, so a person
 * the model found looks and comes off exactly like one the reader picked. A partial name — every
 * subject whose name contains it — ends in an ellipsis, which is the difference that matters: it
 * is a set of people, not one.
 */
export function SearchPills({ filters, onPatch, nameOf }: SearchPillsProps) {
  return (
    <>
      {(filters.subjects ?? []).map((subject) => {
        const { kind, ref } = splitSubject(subject);
        return (
          <Pill key={`subject-${subject}`} withRemoveButton onRemove={() => onPatch({ subjects: without(filters.subjects, subject) })}>
            @{(kind && nameOf(kind, ref)) ?? lastPart(ref)}
          </Pill>
        );
      })}
      {(filters.subjectNames ?? []).map((subjectName) => {
        const { kind, ref: name } = splitSubject(subjectName);
        return (
          <Pill
            key={`name-${subjectName}`}
            withRemoveButton
            title={`Every ${kind ?? 'subject'} whose name contains ${name}`}
            onRemove={() => onPatch({ subjectNames: without(filters.subjectNames, subjectName) })}
          >
            @{name}…
          </Pill>
        );
      })}
      {filters.region && (
        <Pill withRemoveButton title='A map area' onRemove={() => onPatch({ region: undefined })}>
          Area
        </Pill>
      )}
      {(filters.fromYear !== undefined || filters.toYear !== undefined) && (
        <Pill withRemoveButton onRemove={() => onPatch({ fromYear: undefined, toYear: undefined })}>
          {years(filters.fromYear, filters.toYear)}
        </Pill>
      )}
      {(filters.tags ?? []).map((tag) => (
        <Pill key={`tag-${tag}`} withRemoveButton onRemove={() => onPatch({ tags: without(filters.tags, tag) })}>
          #{tag}
        </Pill>
      ))}
      {filters.under && (
        <Pill withRemoveButton onRemove={() => onPatch({ under: undefined })}>
          @{nameOf('album', filters.under) ?? lastPart(filters.under)}
        </Pill>
      )}
      {filters.like?.startsWith(`${TAGS_ROOT}/`) && (
        // A label's tag directory: ranked by what the label's pictures look like, and no picture of its own to show.
        <Pill withRemoveButton title={`Pictures that look like the label ${lastPart(filters.like)}`} onRemove={() => onPatch({ like: undefined })}>
          Looks like {lastPart(filters.like)}
        </Pill>
      )}
      {filters.like && !filters.like.startsWith(`${TAGS_ROOT}/`) && (
        <Pill
          withRemoveButton
          title={`Pictures that look like ${lastPart(filters.like)}`}
          onRemove={() => onPatch({ like: undefined })}
        >
          <img
            src={pictureUrl(filters.like)}
            onError={(event) => {
              // A file whose renditions are not made yet shows as itself.
              const original = fileUrl(filters.like!);
              if (!event.currentTarget.src.endsWith(original)) event.currentTarget.src = original;
            }}
            alt=''
            style={{ width: 16, height: 16, objectFit: 'cover', borderRadius: 2, verticalAlign: 'text-bottom', marginRight: 4 }}
          />
          Similar
        </Pill>
      )}
    </>
  );
}
