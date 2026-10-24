import { ActionIcon, Box, Menu, SegmentedControl, Select, Switch } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconCheck } from '@tabler/icons-react';
import type { ReactNode, RefObject } from 'react';
import { Children, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { usePhone } from '../../hooks/usePhone.ts';
import { scrollToTop } from '../../lib/scroll-to-top.ts';

/**
 * How a `HeaderChoice` draws itself: on its own (the full control at width, its
 * own icon menu on a phone), or as one of several in a `HeaderChoices` — the full
 * control only, or its section of the shared phone menu.
 */
type ChoiceMode = 'own' | 'wide' | 'menu';
const ChoiceModeContext = createContext<ChoiceMode>('own');

export type HeaderChoiceOption = {
  value: string;
  label: string;
  /** Stands for the option on a phone, where the trigger shows the chosen one's icon and nothing else. */
  icon: ReactNode;
};

export type HeaderChoiceProps = {
  /** What is being chosen, as the reader would say it: "Sort", "Show". Names the phone's icon button. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly HeaderChoiceOption[];
  /** How it reads at full width: a dropdown for an order, segments for a filter. */
  variant?: 'select' | 'segmented';
  disabled?: boolean;
};

/**
 * One sort or filter choice in a page header.
 *
 * In full it is a Select or a SegmentedControl. Folded it is an icon button showing the
 * current choice, with the options in a menu, so the header's controls fit on
 * the line beside the filter box instead of stacking below it. Both render and
 * CSS decides which shows (`.mrx-header-wide`/`-narrow`): in a `HeaderFilterBar`,
 * whether the bar's choices fit beside its box; elsewhere, whether the header is
 * phone-narrow, the same container query that lays the header out.
 */
export function HeaderChoice({ label, value, onChange, options, variant = 'select', disabled }: HeaderChoiceProps) {
  const mode = useContext(ChoiceModeContext);
  const selected = options.find((option) => option.value === value) ?? options[0];

  if (mode === 'menu') {
    return (
      <>
        <Menu.Label>{label}</Menu.Label>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            disabled={disabled}
            leftSection={option.icon}
            rightSection={option.value === selected.value && <IconCheck size={16} />}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Menu.Item>
        ))}
      </>
    );
  }

  return (
    <>
      <Box className='mrx-header-wide' maw='100%' style={{ overflowX: variant === 'segmented' ? 'auto' : undefined }}>
        {variant === 'segmented'
          ? (
            <SegmentedControl
              value={selected.value}
              onChange={onChange}
              disabled={disabled}
              data={options.map((option) => ({ value: option.value, label: option.label }))}
            />
          )
          : (
            <Select
              value={selected.value}
              onChange={(next) => next && onChange(next)}
              aria-label={label}
              allowDeselect={false}
              disabled={disabled}
              data={options.map((option) => ({ value: option.value, label: option.label }))}
              w={150}
            />
          )}
      </Box>
      {mode === 'own' && (
        <Box className='mrx-header-narrow'>
          <Menu position='bottom-end' shadow='md' withinPortal disabled={disabled}>
            <Menu.Target>
              <ActionIcon variant='light' size='lg' disabled={disabled} aria-label={`${label}: ${selected.label}`}>
                {selected.icon}
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown className='mrx-entity-header-menu-dropdown'>
              {options.map((option) => (
                <Menu.Item
                  key={option.value}
                  leftSection={option.icon}
                  rightSection={option.value === selected.value && <IconCheck size={16} />}
                  onClick={() => onChange(option.value)}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Box>
      )}
    </>
  );
}

export type HeaderToggleProps = {
  /** What turning it on does, as the reader would say it: "Show only mine". */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Stands for it on a phone when it is on its own, as a button that is filled while on. */
  icon: ReactNode;
};

/**
 * An on/off filter in a page header, the two-state sibling of `HeaderChoice`.
 *
 * At full width it is a small switch and its label in a pill the size and
 * colour of the `SegmentedControl` beside it, so the two read as one set. In a
 * `HeaderChoices` phone menu it is a checkable item; on its own on a phone, an
 * icon button that is filled while on.
 */
export function HeaderToggle({ label, checked, onChange, icon }: HeaderToggleProps) {
  const mode = useContext(ChoiceModeContext);

  if (mode === 'menu') {
    return (
      <Menu.Item leftSection={icon} rightSection={checked && <IconCheck size={16} />} closeMenuOnClick={false} onClick={() => onChange(!checked)}>
        {label}
      </Menu.Item>
    );
  }

  return (
    <>
      <Box className='mrx-header-wide'>
        <Switch
          className='mrx-header-toggle'
          size='sm'
          label={label}
          labelPosition='left'
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </Box>
      {mode === 'own' && (
        <Box className='mrx-header-narrow'>
          <ActionIcon variant={checked ? 'filled' : 'light'} size='lg' aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)}>
            {icon}
          </ActionIcon>
        </Box>
      )}
    </>
  );
}

/**
 * Several `HeaderChoice`s — a filter and a sort — that fold into one button on a
 * phone, each a labelled section of its menu, instead of a button apiece. At
 * width they are the ordinary controls side by side. The children are rendered
 * twice, once for each, so anything but `HeaderChoice`s and `HeaderToggle`s belongs
 * outside. With a single choice there is nothing to combine, and it keeps its own button, which
 * shows the current choice's icon.
 */
export function HeaderChoices({ label = 'Filter and sort', children }: { label?: string; children: ReactNode }) {
  if (Children.toArray(children).length < 2) return <>{children}</>;

  return (
    <>
      <ChoiceModeContext.Provider value='wide'>{children}</ChoiceModeContext.Provider>
      <Box className='mrx-header-narrow'>
        <Menu position='bottom-end' shadow='md' withinPortal>
          <Menu.Target>
            <ActionIcon variant='light' size='lg' aria-label={label}>
              <IconAdjustmentsHorizontal size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown className='mrx-entity-header-menu-dropdown'>
            <ChoiceModeContext.Provider value='menu'>{children}</ChoiceModeContext.Provider>
          </Menu.Dropdown>
        </Menu>
      </Box>
    </>
  );
}

export type HeaderFilterBarProps = {
  /** The filter or search box, and anything that belongs beside it; it gives up width to the controls. */
  input?: ReactNode;
  /** The box's own sizing: a list filter keeps 480px, a search box grows toward 720px. */
  wide?: boolean;
  /** Sort and filter choices, right-aligned. */
  children: ReactNode;
};

/** What the box keeps beside the choices in full before they fold: a list filter, and a search box with its buttons. */
const BOX_ROOM = 240;
const WIDE_BOX_ROOM = 360;

/**
 * The row under a list page's title: the filter box on the left, the choices
 * on the right, on one line at any width. The box gives up width to the
 * choices down to its `BOX_ROOM`; past that the choices fold into their icon
 * buttons (`HeaderChoice`), as they always are on a phone.
 *
 * Scrolled down, the page header holding it stays on screen as this row alone,
 * under the app header (`EntityDetailHeader`). A question changed from the row
 * while the page is scrolled goes back to the top, where its answer starts.
 *
 * The box has the keyboard when the page opens, so typing filters straight
 * away — on a desktop only, where it costs nothing; a phone would put its
 * keyboard over the page just opened. It leaves the focus alone when a text
 * box elsewhere, like the chat's, already has it.
 */
export function HeaderFilterBar({ input, wide, children }: HeaderFilterBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  useFoldedChoices(barRef, controlsRef, input ? (wide ? WIDE_BOX_ROOM : BOX_ROOM) : 0);

  useEffect(() => {
    if (phone) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'))) return;
    inputRef.current?.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus({ preventScroll: true });
    // Once, as the page opens: a later change of width is not a new page.
  }, []);

  // Only the URL's query is a new question: a list's own filter narrows it in place.
  const { search } = useLocation();
  const askedFrom = useRef(search);
  useEffect(() => {
    if (search === askedFrom.current) return;
    askedFrom.current = search;
    if (globalThis.scrollY > 0 && barRef.current?.contains(document.activeElement)) scrollToTop();
  }, [search]);

  return (
    <Box ref={barRef} className='mrx-header-filter-bar'>
      {input && <Box ref={inputRef} className='mrx-header-filter-bar-input' data-wide={wide || undefined}>{input}</Box>}
      <Box ref={controlsRef} className='mrx-header-filter-bar-controls'>{children}</Box>
    </Box>
  );
}

/**
 * Folds the bar's choices into their buttons (`data-collapsed`) when, in full,
 * they would leave the box less than `room` beside them. They are measured in
 * full each time: on every render, since the choices are the page's and change
 * with it, and whenever the bar's width changes.
 */
function useFoldedChoices(barRef: RefObject<HTMLDivElement | null>, controlsRef: RefObject<HTMLDivElement | null>, room: number) {
  const fit = useCallback(() => {
    const bar = barRef.current;
    const controls = controlsRef.current;
    if (!bar || !controls) return;
    bar.removeAttribute('data-collapsed');
    const gap = room > 0 ? parseFloat(getComputedStyle(bar).columnGap) || 0 : 0;
    bar.toggleAttribute('data-collapsed', controls.offsetWidth + gap + room > bar.clientWidth);
  }, [barRef, controlsRef, room]);

  useLayoutEffect(fit);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // The width only: folding can change the bar's height, which is no reason to measure again.
    let width = bar.clientWidth;
    const observer = new ResizeObserver(() => {
      if (bar.clientWidth === width) return;
      width = bar.clientWidth;
      fit();
    });
    observer.observe(bar);
    // The labels' widths change once the fonts are in.
    document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [barRef, fit]);
}
