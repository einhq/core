import { Group, Text } from '@mantine/core';
import { Fragment } from 'react';

/**
 * What a listing holds, in a line under its title: `3,611 albums · 929 people`. Each item is
 * already worded (`countOf`); an item that is not known yet is left out rather than shown as 0.
 */
export function HeaderStats({ items }: { items: (string | false | null | undefined)[] }) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return (
    <Group gap={6} className='mrx-header-stats'>
      {shown.map((item, index) => (
        <Fragment key={item}>
          {index > 0 && <Text span size='sm' c='gray.4' aria-hidden>·</Text>}
          <Text span size='sm' c='gray.2' fw={500}>{item}</Text>
        </Fragment>
      ))}
    </Group>
  );
}
