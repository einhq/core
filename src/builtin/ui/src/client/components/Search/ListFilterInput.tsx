import { CloseButton, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

export type ListFilterInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** What is being filtered, as the reader would say it: "people", "albums". */
  what: string;
  size?: string;
};

/**
 * The filter above a list page — people, albums, locations, labels, devices, tracks.
 *
 * It narrows what the page already holds, as the reader types, by `matchesText` (case and
 * accents aside, every word in any order). It is not the search box: nothing is asked of the
 * server, and there is no `@`.
 */
export function ListFilterInput({ value, onChange, what, size = 'md' }: ListFilterInputProps) {
  return (
    <TextInput
      placeholder={`Filter ${what}…`}
      aria-label={`Filter ${what}`}
      leftSection={<IconSearch size={16} />}
      rightSection={value ? <CloseButton size='sm' aria-label='Clear the filter' onClick={() => onChange('')} /> : undefined}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      size={size}
    />
  );
}
