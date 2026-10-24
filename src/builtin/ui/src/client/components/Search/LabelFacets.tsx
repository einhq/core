import { Badge, Group, Text } from '@mantine/core';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

export type LabelFacetsProps = {
  /** The labels the answer's members carry, from `search --facets`, the most carried first. */
  labels: readonly { label: string; count: number }[];
  /** How many members the answer has. */
  total: number;
  /** Labels the search already asks for; they are on every member, so they are not offered. */
  chosen: readonly string[];
  onChoose: (label: string) => void;
};

/**
 * The labels an answer's members carry, each a pill that narrows the answer to what carries it.
 *
 * A label on every member would narrow nothing and is left out, as are the ones already chosen.
 * With nothing left to offer the row renders nothing.
 */
export function LabelFacets({ labels, total, chosen, onChoose }: LabelFacetsProps) {
  const offered = labels.filter(({ label, count }) => count < total && !chosen.includes(label));
  if (offered.length === 0) return null;

  return (
    <Group gap='sm' wrap='nowrap' align='center' aria-label='Narrow by label'>
      <TablerIcon name='tag' size={16} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
      <Group gap={6} wrap='wrap' style={{ minWidth: 0 }}>
        {offered.map(({ label, count }) => (
          <Badge
            key={label}
            component='button'
            type='button'
            variant='light'
            tt='none'
            fw={500}
            style={{ cursor: 'pointer' }}
            onClick={() => onChoose(label)}
            rightSection={<Text span size='xs' c='dimmed'>{count.toLocaleString()}</Text>}
          >
            {label}
          </Badge>
        ))}
      </Group>
    </Group>
  );
}
