import { ActionIcon, Group, Popover, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import type { SearchDetail } from '../../lib/natural-search.ts';

export type InterpretedFilterProps = {
  /** The rows to explain, from `naturalSearchDetails`. */
  details: readonly SearchDetail[];
  /** A line under the rows, for what the page does with them that the rows do not say. */
  note?: string;
  /** The search box's size, so the icon stands as tall as it. */
  size?: 'sm' | 'md';
  /**
   * The icon's colour. Light by default, for the header artwork every search page but the map
   * puts its box on; the map's box sits on a surface of the theme's own.
   */
  color?: string;
};

/**
 * The info button beside a search box, and what the box was understood to mean behind it.
 *
 * A bare icon rather than a button, next to the box. A page renders it only while there is a
 * filter to explain, so the open state goes with it. Not on a phone, where the box already gives
 * up width to the header's choices and the explanation is not worth the room.
 */
export function InterpretedFilter({ details, note, size = 'md', color = 'gray.2' }: InterpretedFilterProps) {
  const [opened, setOpened] = useState(false);

  return (
    <Popover opened={opened} onChange={setOpened} position='bottom-end' width={420} shadow='lg' withArrow>
      <Popover.Target>
        <ActionIcon
          variant='transparent'
          color={color}
          size={`input-${size}`}
          visibleFrom='sm'
          aria-label='Interpreted filter'
          onClick={() => setOpened((open) => !open)}
        >
          <IconInfoCircle size={size === 'md' ? 22 : 18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown maw='calc(100vw - 32px)'>
        <Stack gap='sm'>
          <Text size='sm' fw={600}>Interpreted filter</Text>
          <Stack gap={4}>
            {details.map((detail) => (
              <Group key={detail.label} gap='xs' align='baseline' wrap='nowrap'>
                <Text size='xs' c='dimmed' w={145} style={{ flexShrink: 0 }}>{detail.label}</Text>
                <Text size='sm' style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{detail.value}</Text>
              </Group>
            ))}
          </Stack>
          {note && <Text size='xs' c='dimmed'>{note}</Text>}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
