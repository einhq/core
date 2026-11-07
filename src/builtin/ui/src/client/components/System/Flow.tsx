import { Box, Group, Stack, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { WORKLOAD_COLORS } from '../Pipeline/palette.ts';

/**
 * The pieces of the Work tab's flow board (`FlowBoard`), exported so a module's part of it (a
 * `system.flow` panel: ems's lanes and models) draws its columns the same way: a column with a
 * colored rule under its heading and a count, the arrow between columns, an item, and slots.
 */

/** A column's width, which a module's columns take too so the board reads as one row. */
export const FLOW_COLUMN_WIDTH = 196;

type FlowColumnProps = {
  title: string;
  /** The column's total, beside its heading; absent while unknown. */
  count?: number;
  /** The rule under the heading: the color of the place the column counts (palette.ts). */
  color: string;
  /** What the column counts, in a line. */
  hint?: string;
  children?: ReactNode;
};

/** One column of the flow board. */
export function FlowColumn({ title, count, color, hint, children }: FlowColumnProps) {
  return (
    <Stack gap={6} w={FLOW_COLUMN_WIDTH} style={{ flex: `0 0 ${FLOW_COLUMN_WIDTH}px` }}>
      <Group gap={6} pb={6} wrap='nowrap' style={{ borderBottom: `2px solid ${color}` }}>
        <Text size='sm' fw={600}>{title}</Text>
        {count !== undefined && <Text ml='auto' fw={650} size='lg' style={{ fontVariantNumeric: 'tabular-nums' }}>{count.toLocaleString()}</Text>}
      </Group>
      {hint && <Text size='xs' c='dimmed'>{hint}</Text>}
      {children}
    </Stack>
  );
}

/** The arrow between two columns. */
export function FlowArrow() {
  return (
    <Box c='dimmed' pt={6} style={{ flex: '0 0 auto' }} aria-hidden>
      <IconArrowRight size={16} />
    </Box>
  );
}

/** A row in a column; `active` outlines the one being worked on now (a worker's turn). */
export function FlowItem({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <Box
      px={8}
      py={6}
      style={{
        borderRadius: 6,
        background: active ? 'color-mix(in srgb, var(--mrx-accent) 12%, var(--mrx-surface-overlay))' : 'var(--mrx-surface-overlay)',
        outline: active ? `1px solid ${WORKLOAD_COLORS.running}` : undefined,
      }}
    >
      {children}
    </Box>
  );
}

/** A small heading inside a column, over the items it groups. */
export function FlowGroupLabel({ children }: { children: ReactNode }) {
  return <Text size='xs' c='dimmed' tt='uppercase' fw={600} mt={4} style={{ letterSpacing: '0.06em', fontSize: 10.5 }}>{children}</Text>;
}

type SlotsProps = {
  /** Slots taken now. */
  used: number;
  /** Slots there are. */
  total: number;
  /** Slots more kept for interactive work, drawn dashed after the rest. */
  reserved?: number;
  label?: string;
};

/** A worker's or a lane's slots as squares: taken ones filled, free ones empty, kept ones dashed. */
export function FlowSlots({ used, total, reserved = 0, label }: SlotsProps) {
  const cells = Array.from({ length: Math.min(total + reserved, 32) }, (_, index) => index < Math.min(used, total + reserved) ? 'on' : index < total ? 'free' : 'kept');
  return (
    <Group gap={3} wrap='wrap' aria-label={label ?? `${used} of ${total} in use`} title={label ?? `${used} of ${total} in use`}>
      {cells.map((cell, index) => (
        <Box
          key={index}
          w={11}
          h={11}
          style={{
            borderRadius: 3,
            background: cell === 'on' ? WORKLOAD_COLORS.running : cell === 'free' ? 'var(--mrx-surface-raised)' : 'transparent',
            border: cell === 'on' ? `1px solid ${WORKLOAD_COLORS.running}` : cell === 'free' ? '1px solid var(--mrx-hairline)' : '1px dashed var(--mrx-text-tertiary)',
          }}
        />
      ))}
    </Group>
  );
}
