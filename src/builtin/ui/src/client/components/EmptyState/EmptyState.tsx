import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { HAT_CLUSTER, HAT_CLUSTER_VIEWBOX, HAT_POINTS } from '../../lib/hat.ts';

type EmptyStateProps = {
  /** What is missing, in a few words. */
  title: ReactNode;
  /** What fills it, or where it comes from. */
  children?: ReactNode;
  /** Buttons that fill it from here. */
  actions?: ReactNode;
};

/**
 * What a page shows when it has nothing to list: a muted cluster of the hats the headers are
 * laid with, a title, a line on how it fills, and the actions that fill it.
 */
export function EmptyState({ title, children, actions }: EmptyStateProps) {
  return (
    <Stack className='mrx-empty-state' align='center' gap='xs' py='xl' ta='center'>
      <svg className='mrx-empty-state-art' viewBox={HAT_CLUSTER_VIEWBOX} aria-hidden focusable='false'>
        {HAT_CLUSTER.map((transform, i) => <polygon key={transform} points={HAT_POINTS} transform={transform} data-lit={i === 1 || undefined} />)}
      </svg>
      <Text fw={600}>{title}</Text>
      {children && <Text c='dimmed' size='sm' maw={440}>{children}</Text>}
      {actions && <Group justify='center' gap='xs' mt='xs'>{actions}</Group>}
    </Stack>
  );
}
