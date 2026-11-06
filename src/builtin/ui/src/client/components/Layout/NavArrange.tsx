import { Box, Menu } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconArrowDown, IconArrowUp, IconLayoutNavbar, IconLayoutSidebar, IconSearch, IconUserCircle } from '@tabler/icons-react';
import { type DragEvent, type ReactNode, useRef, useState } from 'react';
import { uiNav } from '@ein/ui/signals';
import { accepts, type Movable, type NavSpot } from '../../lib/nav-arrange.ts';
import { ACCOUNT_MENU, moveNavEntry, navDragged, nudgeNavEntry } from '../../signals/nav-arrange.ts';

/** A spot's key, to compare two. */
const spotKey = (spot: NavSpot): string => spot.kind === 'section' ? `section:${spot.section}` : spot.kind === 'menu' ? `menu:${spot.parent}` : spot.kind;

/** Where a drop lands among a zone's entries: before the first whose middle is past the pointer, or at the end. */
const indexAt = (zone: HTMLElement, axis: 'x' | 'y', event: DragEvent): number => {
  const items = [...zone.querySelectorAll<HTMLElement>('[data-arrange-item]')];
  const at = items.findIndex((item) => {
    const box = item.getBoundingClientRect();
    return axis === 'y' ? event.clientY < box.top + box.height / 2 : event.clientX < box.left + box.width / 2;
  });
  return at < 0 ? items.length : at;
};

/**
 * A place entries are dropped while arranging: a sidebar section, a part of the top bar, the
 * account menu. `zone` goes on the element around its entries (`axis` is the way they run), and
 * `mark(i)` on the i-th of them, for the line where a drop would land.
 */
export function useArrangeZone(spot: NavSpot, axis: 'x' | 'y') {
  useSignals();
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragged = navDragged.value;
  const open = dragged !== null && accepts(spot, dragged);

  const zone = {
    ref,
    'data-arrange-zone': axis,
    'data-over': over !== null || undefined,
    onDragOver: (event: DragEvent) => {
      if (!open || !ref.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(indexAt(ref.current, axis, event));
    },
    onDragLeave: (event: DragEvent) => {
      if (!ref.current?.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      if (!open || !ref.current || !dragged) return;
      event.preventDefault();
      const index = indexAt(ref.current, axis, event);
      setOver(null);
      navDragged.value = null;
      void moveNavEntry(dragged, spot, index);
    },
  };
  /** The mark for the i-th of `count` entries: a line before it, or after the last. */
  const mark = (i: number, count: number): 'before' | 'after' | undefined => over === i ? 'before' : over === count && i === count - 1 ? 'after' : undefined;
  return { zone, mark, over };
}

/** What a "Move to" menu offers: each sidebar section, the top bar, beside the search box, the account menu. */
function destinations(): { spot: NavSpot; label: string; icon: ReactNode }[] {
  const sections = uiNav.value.sections.map((section, index) => ({
    spot: { kind: 'section', section: section.id } as NavSpot,
    label: section.label ? `Sidebar: ${section.label}` : index === 0 ? 'Sidebar: top' : 'Sidebar',
    icon: <IconLayoutSidebar size={14} />,
  }));
  return [
    ...sections,
    { spot: { kind: 'topbar' }, label: 'Top bar', icon: <IconLayoutNavbar size={14} /> },
    { spot: { kind: 'search' }, label: 'Beside search', icon: <IconSearch size={14} /> },
    { spot: { kind: 'menu', parent: ACCOUNT_MENU }, label: 'Account menu', icon: <IconUserCircle size={14} /> },
  ];
}

/**
 * One entry while arranging: dragged to another zone, or chosen for a menu that moves it a step or
 * to another place, which is how a phone's finger and the keyboard arrange. `children` is what the
 * entry draws, which does nothing of its own while arranging.
 */
export function ArrangeItem({ entry, spot, label, mark, children }: { entry: Movable; spot: NavSpot; label: string; mark?: 'before' | 'after'; children: ReactNode }) {
  useSignals();
  const here = spotKey(spot);
  return (
    <Menu shadow='md' width={220} position='bottom-start' withinPortal>
      <Menu.Target>
        <Box
          draggable
          data-arrange-item
          data-arrange-mark={mark}
          aria-label={`Move ${label}`}
          onDragStart={(event: DragEvent) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', label);
            navDragged.value = entry;
          }}
          onDragEnd={() => (navDragged.value = null)}
        >
          {children}
        </Box>
      </Menu.Target>
      <Menu.Dropdown className='mrx-topbar-menu'>
        <Menu.Label>{label}</Menu.Label>
        <Menu.Item leftSection={<IconArrowUp size={14} />} onClick={() => void nudgeNavEntry(entry, spot, -1)}>Earlier</Menu.Item>
        <Menu.Item leftSection={<IconArrowDown size={14} />} onClick={() => void nudgeNavEntry(entry, spot, 1)}>Later</Menu.Item>
        <Menu.Label>Move to</Menu.Label>
        {destinations().map(({ spot: to, label: name, icon }) => (
          <Menu.Item
            key={spotKey(to)}
            leftSection={icon}
            disabled={spotKey(to) === here || !accepts(to, entry)}
            onClick={() => void moveNavEntry(entry, to)}
          >
            {name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
