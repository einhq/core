/**
 * The Settings tabs that list entries beside the open one (Users, Groups, Modules): the split that
 * holds them, the panes' scrolling, and the list's frame — a filter on top, beside an optional
 * action, a row per entry that opens it, and an optional footer.
 */

import { Box, Button, Group, Paper, ScrollArea, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import { type ReactNode, type Ref, useEffect, useRef } from 'react';
import { usePhone } from '../../hooks/usePhone.ts';
import { ListFilterInput } from '../Search/ListFilterInput.tsx';

/** The tab's width from which the list and the open entry stand side by side; narrower, they take turns. */
export const SPLIT_MIN_WIDTH = 720;

/**
 * Keeps `--mrx-settings-around` on the split at how much of the window's height the page takes
 * above and below it: its distance from the top of the page, plus the padding of every box around
 * it under the body. The stylesheet gives it the rest of the window. Measured again whenever what
 * stands before it, or before a box around it, changes size: the page's header, the tab's top
 * row, all of them when the page narrows. Never the boxes around it, whose height follows its
 * own and would answer every change with another.
 */
export function fillWindow(split: HTMLElement | null) {
  if (!split) return;
  const place = () => {
    let around = split.getBoundingClientRect().top + globalThis.scrollY;
    for (let box = split.parentElement; box && box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      around += parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
    }
    // Rounded up: a fraction of a pixel over the window's foot would let the page scroll.
    const value = `${Math.ceil(around)}px`;
    if (split.style.getPropertyValue('--mrx-settings-around') !== value) split.style.setProperty('--mrx-settings-around', value);
  };
  place();
  const observer = new ResizeObserver(place);
  for (let box: Element | null = split; box && box !== document.body; box = box.parentElement) {
    for (let before = box.previousElementSibling; before; before = before.previousElementSibling) observer.observe(before);
  }
  return () => observer.disconnect();
}

/**
 * What a list or panel holds. With `scrolls`, beside the other pane, it scrolls in its own box with
 * the app's scrollbar, as the chat's recent chats do, and a scroll that reaches its end stops
 * there; `viewportRef` is the element that scrolls. Otherwise it is as long as what it holds.
 */
export function PaneScroll({ scrolls, viewportRef, children }: { scrolls: boolean; viewportRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  if (!scrolls) return <>{children}</>;
  return (
    <ScrollArea
      viewportRef={viewportRef}
      type='auto'
      scrollbars='y'
      offsetScrollbars='y'
      overscrollBehavior='contain'
      style={{ flex: 1, minHeight: 0 }}
    >
      {children}
    </ScrollArea>
  );
}

type ListFrameProps = {
  /** What is listed, as the reader says it: `users`, `modules`. */
  what: string;
  filter: string;
  onFilter: (next: string) => void;
  /** Nothing has arrived yet: rows of placeholders hold the list's place. */
  loading: boolean;
  rows: ReactNode[];
  /** Beside the filter: the button that makes a new entry. */
  action?: ReactNode;
  footer?: ReactNode;
  /** Beside the open entry: the rows scroll between the filter and the footer. */
  scrolls: boolean;
};

/**
 * A filter box over the rows. Beside the open entry (`.mrx-settings-split`, `scrolls`) the frame is
 * as tall as the split and its rows scroll between the filter and the footer; elsewhere it is as
 * long as its rows. On a phone it is no box at all: the filter and rows use the page's width.
 */
export function ListFrame({ what, filter, onFilter, loading, rows, action, footer, scrolls }: ListFrameProps) {
  const flat = usePhone();
  return (
    <Paper withBorder={!flat} bg={flat ? 'transparent' : undefined} radius='md' className='mrx-settings-list' data-flat={flat || undefined}>
      <Group p={flat ? 0 : 'xs'} pb='xs' gap='xs' wrap='nowrap'>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <ListFilterInput value={filter} onChange={onFilter} what={what} size='sm' />
        </Box>
        {action}
      </Group>
      <PaneScroll scrolls={scrolls}>
        <Box px={flat ? 0 : 'xs'} pb='xs'>
          {loading ? <RowSkeletons /> : rows.length > 0 ? <Stack gap={2}>{rows}</Stack> : filter.trim()
            ? (
              <Stack align='center' gap={6} py='lg'>
                <Text size='sm' c='dimmed' ta='center' style={{ overflowWrap: 'anywhere' }}>No {what} match “{filter.trim()}”</Text>
                <Button variant='subtle' size='xs' onClick={() => onFilter('')}>Clear</Button>
              </Stack>
            )
            : <Text size='sm' c='dimmed' ta='center' py='lg'>No {what} yet</Text>}
        </Box>
      </PaneScroll>
      {footer && <Box className='mrx-settings-list-foot' px={flat ? 0 : 'sm'} py='xs'>{footer}</Box>}
    </Paper>
  );
}

function RowSkeletons() {
  return (
    <Stack gap={2} aria-hidden>
      {[0, 1, 2, 3, 4].map((key) => (
        <Group key={key} gap='sm' wrap='nowrap' px='sm' py={8}>
          <Skeleton height={36} width={36} radius='md' />
          <Stack gap={6} style={{ flex: 1 }}>
            <Skeleton height={12} width='60%' />
            <Skeleton height={10} width='40%' />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

type ListRowProps = {
  selected: boolean;
  onClick: () => void;
  /** A picture, hidden from screen readers, which have the title and subtitle. */
  avatar: ReactNode;
  title: string;
  /** The dimmed line under the title: an account's or group's name, a module's description. */
  subtitle: string;
  /** At the row's right: a state badge, a group's faces. */
  aside?: ReactNode;
};

/** One entry as a button; the open one is marked, and brought into view in a list that scrolls. */
export function ListRow({ selected, onClick, avatar, title, subtitle, aside }: ListRowProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <UnstyledButton ref={ref} className='mrx-settings-row' aria-current={selected ? 'true' : undefined} onClick={onClick}>
      <Group gap='sm' wrap='nowrap'>
        <Box aria-hidden style={{ flex: 'none', position: 'relative' }}>{avatar}</Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' fw={600} truncate title={title}>{title}</Text>
          <Text size='xs' c='dimmed' truncate title={subtitle}>{subtitle}</Text>
        </Box>
        {aside}
      </Group>
    </UnstyledButton>
  );
}
