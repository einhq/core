/**
 * Controls for a value that names accounts or groups, or is a mode: each takes and gives the
 * string a setting holds, and offers what `useIdentities()` lists. With them, how a mode setting's
 * text is read and compared, and a picker's placeholder for a setting's empty value.
 */

import { Box, type MantineStyleProp, MultiSelect, type MultiSelectProps, SegmentedControl, Select, type SelectProps, Stack, Text } from '@mantine/core';
import { IconEye, IconLock, IconPencil } from '@tabler/icons-react';
import { Fragment, useMemo } from 'react';
import type { ConfigEntry, ShareLevel } from '@ein/api';
import { useIdentities } from '../../hooks/useIdentities.ts';
import { accountOption, formatGroupList, parseGroupList, sortGroups, sortUsers } from '../../lib/accounts.ts';
import { levelAt, withLevelAt } from '../../lib/share.ts';

type Option = { value: string; label: string };

type PickerProps = Omit<SelectProps, 'data' | 'value' | 'onChange'> & {
  value: string;
  onChange: (next: string) => void;
  /** What an empty value means. Given, the value can be cleared and this is the placeholder. */
  emptyLabel?: string;
};

type MultiPickerProps = Omit<MultiSelectProps, 'data' | 'value' | 'onChange'> & {
  /** A comma list of group names. */
  value: string;
  onChange: (next: string) => void;
};

/**
 * The options offered, then each saved name that is not among them, so a field shows what is saved
 * rather than going blank: one left out of the choice (the guest) under its own label, and one that
 * names nothing as not found — once the lists have arrived.
 */
function withSaved(offered: Option[], every: Option[], saved: string[], loaded: boolean): Option[] {
  const missing = saved.filter((name) => !offered.some((option) => option.value === name));
  return [...offered, ...missing.map((name) => every.find((option) => option.value === name) ?? { value: name, label: loaded ? `${name} (not found)` : name })];
}

/** `saved` is the value as the setting holds it: one name, or a comma list of them. */
function useUserOptions(saved: string): Option[] {
  const { users } = useIdentities();
  return useMemo(() => {
    const every = sortUsers(users).map(accountOption);
    const offered = sortUsers(users.filter((user) => user.role !== 'guest')).map(accountOption);
    return withSaved(offered, every, parseGroupList(saved), users.length > 0);
  }, [users, saved]);
}

function useGroupOptions(saved: string): Option[] {
  const { groups } = useIdentities();
  return useMemo(() => {
    const every = sortGroups(groups).map(accountOption);
    const offered = sortGroups(groups.filter((group) => group.role !== 'guests')).map(accountOption);
    return withSaved(offered, every, parseGroupList(saved), groups.length > 0);
  }, [groups, saved]);
}

/** One account by username, from every account but the guest. */
export function UserSelect({ value, onChange, emptyLabel, ...rest }: PickerProps) {
  const data = useUserOptions(value);
  const optional = emptyLabel !== undefined;
  return (
    <Select
      searchable
      clearable={optional}
      allowDeselect={optional}
      placeholder={emptyLabel}
      nothingFoundMessage='Nobody by that name'
      {...rest}
      data={data}
      value={value || null}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}

/** One group by name, from every group but the guest's; personal groups are offered too. */
export function GroupSelect({ value, onChange, emptyLabel, ...rest }: PickerProps) {
  const data = useGroupOptions(value);
  const optional = emptyLabel !== undefined;
  return (
    <Select
      searchable
      clearable={optional}
      allowDeselect={optional}
      placeholder={emptyLabel}
      nothingFoundMessage='No group by that name'
      {...rest}
      data={data}
      value={value || null}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}

/** Several groups, as the comma list a setting holds them in. */
export function GroupsMultiSelect({ value, onChange, ...rest }: MultiPickerProps) {
  const data = useGroupOptions(value);
  return (
    <MultiSelect
      searchable
      hidePickedOptions
      nothingFoundMessage='No group by that name'
      {...rest}
      data={data}
      value={parseGroupList(value)}
      onChange={(next) => onChange(formatGroupList(next))}
    />
  );
}

const CLASSES = [
  { label: 'Owner', shift: 6 },
  { label: 'Group', shift: 3 },
  { label: 'Everyone else', shift: 0 },
];

/** Each level with its icon, and the hue its pill takes when chosen; none keeps the plain pill. */
const LEVELS: { value: ShareLevel; label: string; Icon: typeof IconLock; hue?: string }[] = [
  { value: 'none', label: 'None', Icon: IconLock },
  { value: 'view', label: 'View', Icon: IconEye, hue: 'teal' },
  { value: 'edit', label: 'Edit', Icon: IconPencil, hue: 'marine' },
];

const LEVEL_DATA = LEVELS.map(({ value, label, Icon }) => ({
  value,
  label: (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Icon size={13} aria-hidden />
      {label}
    </span>
  ),
}));

const isLevel = (value: string): value is ShareLevel => LEVELS.some((level) => level.value === value);

/** The chosen pill's colour: the level's hue mixed into the overlay surface the theme gives a pill. */
const levelStyle = (level: ShareLevel | undefined): MantineStyleProp => {
  const hue = LEVELS.find((entry) => entry.value === level)?.hue;
  return hue ? { '--sc-color': `color-mix(in srgb, var(--mantine-color-${hue}-filled) 40%, var(--mrx-surface-overlay))` } : undefined;
};

/**
 * A mode setting's value as a number, the setuid, setgid and sticky bits included: three or four
 * octal digits, with or without a leading 0, as the setting accepts. `undefined` for anything else.
 */
export function parseModeSetting(text: string): number | undefined {
  return /^0?[0-7]{3,4}$/.test(text) ? parseInt(text, 8) : undefined;
}

/** `0o755` → `0755`, `0o2775` → `2775`: four digits, the form a mode setting is saved in. */
const formatModeSetting = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, '0');

/** Whether two mode settings' texts are the same mode however written (`755` is `0755`); text that is not a mode compares as text. */
export function sameMode(a: string, b: string): boolean {
  const left = parseModeSetting(a);
  const right = parseModeSetting(b);
  return left !== undefined && right !== undefined ? left === right : a === b;
}

/** `the person who creates it` → `The person who creates it`, a picker's placeholder for an empty value. */
export const emptyLabel = (entry: ConfigEntry): string | undefined => entry.emptyMeans ? entry.emptyMeans[0].toUpperCase() + entry.emptyMeans.slice(1) : undefined;

type PermissionsInputProps = {
  /** An octal mode, as in `0755`. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
  /** The id of the element that names the whole control, such as the setting's label. */
  labelledBy?: string;
  /** The group the mode is for, named on the group's row. */
  group?: string;
};

/**
 * A mode as what the owner, the group and everyone else may do with it: none, view or edit, each
 * written back as a whole class of bits, with the octal under the rows. The setuid, setgid and
 * sticky bits are kept as they are. A value that is not an octal mode is shown as it is, and the
 * levels cannot be changed from it.
 */
export function PermissionsInput({ value, onChange, disabled, id, labelledBy, group }: PermissionsInputProps) {
  const mode = parseModeSetting(value);
  return (
    <Stack id={id} role='group' aria-labelledby={labelledBy} gap={6}>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, max-content) max-content',
          alignItems: 'center',
          columnGap: 'var(--mantine-spacing-sm)',
          rowGap: 6,
        }}
      >
        {CLASSES.map(({ label, shift }) => {
          const name = shift === 3 && group ? `${label} “${group}”` : label;
          const level = mode === undefined ? undefined : levelAt(mode, shift);
          return (
            <Fragment key={shift}>
              <Text size='sm' truncate>{name}</Text>
              <SegmentedControl
                size='xs'
                aria-label={`${name} may`}
                data={LEVEL_DATA}
                value={level ?? ''}
                disabled={disabled || mode === undefined}
                style={levelStyle(level)}
                onChange={(next) => {
                  if (mode !== undefined && isLevel(next)) onChange(formatModeSetting(withLevelAt(mode, shift, next)));
                }}
              />
            </Fragment>
          );
        })}
      </Box>
      <Text size='xs' c='dimmed' ff='monospace'>{mode === undefined ? `Not a mode: ${value}` : `as ${formatModeSetting(mode)}`}</Text>
    </Stack>
  );
}
