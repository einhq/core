import { ActionIcon, Kbd, Popover, TextInput } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconArrowRight, IconSearch } from '@tabler/icons-react';
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { usePhone } from '../../hooks/usePhone.ts';
import { setHeaderFinder } from '../../signals/palette.ts';
import { MOD_KEY } from '../../signals/shortcuts.ts';
import { FinderHint, FinderRows } from '../Palette/FinderRows.tsx';
import { useFinder } from '../Palette/useFinder.tsx';

/** The finder's width under the box on a desktop: wider than the box, so a row's detail has room. */
const FINDER_WIDTH = 560;

/** Room kept between the results and the keyboard (or the screen's bottom edge). */
const DROPDOWN_BOTTOM_GAP = 8;

/**
 * Keep an open result list inside what a phone actually shows, and keep a swipe
 * on it from moving the page.
 *
 * The keyboard covers the lower half of the screen without shrinking the layout,
 * so a list sized for the layout runs on under the keyboard and cannot scroll
 * itself. A swipe on it then scrolls the page, or on iOS pans the visible area,
 * and the fixed header and the list anchored to it slide out of view together.
 * So while the list is open its height is capped at the visual viewport's
 * bottom edge, which is the keyboard's top edge, and every touchmove is
 * cancelled except one inside a list that has something to scroll. The list's
 * own `overscroll-behavior: contain` stops that scroll chaining on at its ends.
 * Returns the height cap, undefined while inactive.
 */
function useVisibleDropdownHeight(dropdown: RefObject<HTMLDivElement | null>, active: boolean): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number>();

  useEffect(() => {
    if (!active) {
      setMaxHeight(undefined);
      return;
    }

    const viewport = globalThis.visualViewport;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = dropdown.current;
        if (!element) return;
        const bottom = viewport ? viewport.offsetTop + viewport.height : globalThis.innerHeight;
        setMaxHeight(Math.max(0, Math.floor(bottom - element.getBoundingClientRect().top - DROPDOWN_BOTTOM_GAP)));
      });
    };
    const holdPage = (event: TouchEvent) => {
      const element = dropdown.current;
      const inList = element && event.target instanceof Node && element.contains(event.target);
      if (inList && element.scrollHeight > element.clientHeight) return;
      if (event.cancelable) event.preventDefault();
    };

    fit();
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    globalThis.addEventListener('resize', fit);
    document.addEventListener('touchmove', holdPage, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
      globalThis.removeEventListener('resize', fit);
      document.removeEventListener('touchmove', holdPage);
    };
  }, [dropdown, active]);

  return maxHeight;
}

/**
 * The top bar's search box: the finder (`useFinder`) in a list under it, open while the box has
 * focus, and what Mod+K focuses. Enter takes typed words to the Search page unless an arrow chose
 * another row; a query starting with `>` is for commands. A chosen row empties the box and lets go
 * of it, closing the list (and a phone's keyboard).
 */
export function HeaderSearch() {
  useSignals();
  // On a phone the box is squeezed between the mark and the header's buttons.
  // The keyboard's Search key replaces the trailing button, the list gets the
  // screen's width rather than the box's, and the text is 16px because iOS
  // zooms the page into any input set smaller.
  const phone = usePhone();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const finder = useFinder(query, focused, () => {
    setQuery('');
    inputRef.current?.blur();
  });
  const dropdownHeight = useVisibleDropdownHeight(dropdownRef, focused && phone);

  useEffect(() => {
    setHeaderFinder(inputRef.current);
    return () => setHeaderFinder(null);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      inputRef.current?.blur();
      return;
    }
    finder.onKeyDown(event);
  };

  // The search row is the first of typed words; the arrow button runs it, as Enter does.
  const search = () => finder.items.find((item) => item.id === 'search:all')?.run();

  return (
    <Popover opened={focused} position='bottom-start' width={phone ? 'calc(100vw - 24px)' : FINDER_WIDTH} shadow='lg'>
      <Popover.Target>
        <TextInput
          ref={inputRef}
          value={query}
          size='sm'
          placeholder={phone ? 'Search' : 'Search for anything'}
          aria-label='Search, or go to a page, person or album'
          enterKeyHint='search'
          styles={phone ? { input: { fontSize: 16 } } : undefined}
          leftSection={<IconSearch size={18} />}
          rightSection={phone ? undefined : query.trim()
            ? (
              <ActionIcon variant='subtle' size='lg' aria-label='Search' onClick={search}>
                <IconArrowRight size={16} />
              </ActionIcon>
            )
            : <Kbd size='xs'>{MOD_KEY}+K</Kbd>}
          rightSectionWidth={!phone && !query.trim() ? 64 : undefined}
          rightSectionPointerEvents={query.trim() ? 'all' : 'none'}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
      </Popover.Target>

      <Popover.Dropdown
        ref={dropdownRef}
        p={0}
        mah={phone ? dropdownHeight : '60vh'}
        style={{ overflowY: 'auto', overscrollBehavior: 'contain', scrollPaddingBottom: 32 }}
      >
        <FinderRows finder={finder} />
        <FinderHint finder={finder} />
      </Popover.Dropdown>
    </Popover>
  );
}
