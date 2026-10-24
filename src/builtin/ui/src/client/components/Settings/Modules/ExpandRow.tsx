import { ActionIcon, Box, Table } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { type ReactNode, useId } from 'react';

type ExpandRowProps = {
  open: boolean;
  onToggle: () => void;
  /** What the toggle says to a screen reader: `Help for assistant-ask`. */
  label: string;
  /** The row's cells after the toggle's. */
  cells: ReactNode;
  /** How many columns the table has, the toggle's included, for the opened part to span. */
  columns: number;
  /** What opens under the row; drawn only while it is open. */
  children: ReactNode;
};

/**
 * A table row that opens like an accordion: a chevron button in its first cell, and under it, while
 * open, a row across the table holding `children`. A click anywhere on the row toggles it, but not
 * one in what it opened, and not one that selects text.
 */
export function ExpandRow({ open, onToggle, label, cells, columns, children }: ExpandRowProps) {
  const id = useId();
  return (
    <>
      <Table.Tr
        className='mrx-expand-row'
        data-open={open || undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a, button') || getSelection()?.toString()) return;
          onToggle();
        }}
      >
        <Table.Td w={36} pr={0}>
          <ActionIcon variant='subtle' color='gray' size='sm' aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} onClick={onToggle}>
            <IconChevronRight size={16} className='mrx-expand-chevron' />
          </ActionIcon>
        </Table.Td>
        {cells}
      </Table.Tr>
      {open && (
        <Table.Tr className='mrx-expand-body'>
          <Table.Td colSpan={columns} id={id}>
            <Box px='sm' pb='sm'>{children}</Box>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}
