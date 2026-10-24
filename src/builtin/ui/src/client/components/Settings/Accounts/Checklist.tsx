/**
 * A list of checkboxes for which groups an account is in, or who is in a group: ticked first, a
 * filter once the list is long, and the reason beside anything that can't be changed here.
 */

import { Box, Button, Checkbox, Group, Loader, SimpleGrid, Stack, Text } from '@mantine/core';
import { type ReactNode, useState } from 'react';
import { matchesText } from '../../../lib/text-match.ts';
import { ListFilterInput } from '../../Search/ListFilterInput.tsx';

export type ChecklistItem = {
  value: string;
  label: string;
  /** A second line under the label: the name, when the title differs from it. */
  description?: string;
  /** A 24px picture before the label. */
  avatar?: ReactNode;
  checked: boolean;
  /** Can't be changed here; `note` says why. */
  disabled?: boolean;
  /** Why the item is as it is, said under it: `primary group`, `everyone who signs in`. */
  note?: string;
  /** Its change is under way: a loader beside it, and the box ignores clicks until it lands. */
  busy?: boolean;
};

type ChecklistProps = {
  items: ChecklistItem[];
  onToggle: (value: string, next: boolean) => void;
  /** Names the list for assistive technology: `Groups anna is in`. */
  label: string;
  /** What the filter narrows, as the reader says it: `groups`, `people`. */
  what: string;
  /** The account or group the list is about; the order is set again when it changes. */
  resetKey?: string;
  /** Every box, while the form the list is in is busy. */
  disabled?: boolean;
};

/** A list longer than this has a filter above it. */
const FILTER_ABOVE = 8;

const AVATAR = 24;

/** The values in the order they are shown: the ticked ones first, each part in the order given. */
const ticksFirst = (items: ChecklistItem[]): string[] => [...items.filter((item) => item.checked), ...items.filter((item) => !item.checked)].map((item) => item.value);

/**
 * The items as checkboxes in as many columns as the space allows. The order is set when the list
 * opens and kept while boxes are ticked, so the box just clicked stays under the pointer and keeps
 * the focus; an item that arrives later goes last.
 */
export function Checklist({ items, onToggle, label, what, resetKey, disabled }: ChecklistProps) {
  const [order, setOrder] = useState(() => ({ key: resetKey, values: ticksFirst(items) }));
  const [filter, setFilter] = useState('');
  if (order.key !== resetKey) {
    setOrder({ key: resetKey, values: ticksFirst(items) });
    setFilter('');
  }

  const rank = new Map(order.values.map((value, index) => [value, index]));
  const ordered = items
    .map((item, index) => ({ item, at: rank.get(item.value) ?? order.values.length + index }))
    .sort((a, b) => a.at - b.at)
    .map(({ item }) => item);
  const shown = ordered.filter((item) => matchesText([item.label, item.description, item.value], filter));

  return (
    <Stack gap='sm' role='group' aria-label={label}>
      {items.length > FILTER_ABOVE && (
        <Box maw={360}>
          <ListFilterInput value={filter} onChange={setFilter} what={what} size='sm' />
        </Box>
      )}
      {shown.length > 0
        ? (
          <SimpleGrid type='container' cols={{ base: 1, '400px': 2, '680px': 3 }} spacing='md' verticalSpacing='xs'>
            {shown.map((item) => <ChecklistRow key={item.value} item={item} disabled={disabled} onToggle={onToggle} />)}
          </SimpleGrid>
        )
        : filter.trim() && (
          <Group gap='xs'>
            <Text size='sm' c='dimmed' style={{ overflowWrap: 'anywhere' }}>No {what} match “{filter.trim()}”</Text>
            <Button variant='subtle' size='compact-sm' onClick={() => setFilter('')}>Clear</Button>
          </Group>
        )}
    </Stack>
  );
}

function ChecklistRow({ item, disabled, onToggle }: { item: ChecklistItem; disabled?: boolean; onToggle: ChecklistProps['onToggle'] }) {
  const lineHeight = item.avatar ? AVATAR : 20;
  const label = item.avatar
    ? (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ display: 'inline-flex', flex: 'none', width: AVATAR, height: AVATAR }}>{item.avatar}</span>
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.label}</span>
      </span>
    )
    : <span style={{ overflowWrap: 'anywhere' }}>{item.label}</span>;
  const description = item.description || item.note
    ? (
      <>
        {item.description && (
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.description}>{item.description}</span>
        )}
        {item.note && <span style={{ display: 'block' }}>{item.note}</span>}
      </>
    )
    : undefined;

  return (
    <Group gap={4} wrap='nowrap' align='flex-start'>
      <Checkbox
        style={{ flex: 1, minWidth: 0 }}
        checked={item.checked}
        disabled={disabled || item.disabled}
        // Busy, the box keeps its place and the focus, and ignores clicks.
        readOnly={item.busy}
        aria-busy={item.busy || undefined}
        onChange={(event) => onToggle(item.value, event.currentTarget.checked)}
        label={label}
        description={description}
        styles={{
          labelWrapper: { flex: 1, minWidth: 0 },
          // The box sits level with the avatar's middle, and the lines under the label start under its text.
          ...(item.avatar
            ? {
              inner: { marginTop: (AVATAR - 20) / 2 },
              description: { paddingInlineStart: `calc(var(--label-offset-start) + ${AVATAR + 8}px)` },
            }
            : {}),
        }}
      />
      <Box w={16} h={lineHeight} style={{ flex: 'none', display: 'flex', alignItems: 'center' }}>
        {item.busy && <Loader size={14} />}
      </Box>
    </Group>
  );
}
