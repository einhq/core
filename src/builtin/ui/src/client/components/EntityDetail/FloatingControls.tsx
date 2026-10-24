import { Box, Portal, Transition } from '@mantine/core';
import { type FocusEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { floatingControlsShown, floatingControlsTyping } from '../../signals/floating-controls.ts';
import { RISE, RISE_DURATION, RISE_EASE } from '../Layout/rise.ts';

const typingIn = (event: FocusEvent): boolean => event.target instanceof HTMLElement && event.target.matches('input, textarea');

/** How much a phone's keyboard takes off the visible height, at least, in px; less is the URL bar. */
const KEYBOARD_HEIGHT = 150;

/**
 * A page header's controls on a phone once the header has scrolled away (`EntityDetailHeader`): a
 * second copy of them, floating over the page's foot beside back to top. It
 * rises from the bottom edge while `shown`, and sinks back as the header returns. While it is up,
 * `.mrx-floating` is on <html>, so a page's time rail can end above it.
 *
 * The copy is the header's own controls rendered again, so whatever state they show is the page's
 * and both copies agree. While its box has the keyboard it stays, whatever the page does under the
 * phone's keyboard, until the question it asked changes the URL: then it lets go of the keyboard
 * and the page, back at its top, shows the answer.
 *
 * Their filter or search box, empty and without the keyboard, folds to one more round button
 * (`data-folded`), its magnifier, at the end of the row beside the choices. While it has the
 * keyboard (`data-typing`) it takes the whole row: the choices beside it and back to top sink away
 * as they came, and the box stretches over their room (`arrange`).
 * Let go of with something in it, it keeps its width beside them; empty, it folds again. Closing
 * the phone's keyboard lets go of the box, which a phone does not do by itself.
 */
export function FloatingControls({ shown, children }: { shown: boolean; children: ReactNode }) {
  const [typing, setTyping] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [field, setField] = useState<'none' | 'empty' | 'filled'>('none');
  const mounted = shown || typing;

  // Lays the row out around the filter or search box: the slot's child that holds it is the box
  // (`data-floating-box`); everything after it — a button beside it, then the choices — stands over
  // the row's end, right to left (`data-floating-end` at `--mrx-floating-end`), and the box keeps
  // their room (`--mrx-floating-ends-width`). Also reads whether the box holds anything — words, or
  // a chip. A row without a box keeps its ordinary flow.
  const arrange = useCallback(() => {
    const bar = box?.querySelector<HTMLElement>('.mrx-header-filter-bar');
    const slot = bar?.querySelector<HTMLElement>(':scope > .mrx-header-filter-bar-input');
    const held = slot && [...slot.children].find((child) => child.querySelector('.mantine-Input-input'));
    if (!box || !bar || !slot || !(held instanceof HTMLElement)) {
      setField('none');
      return;
    }
    held.setAttribute('data-floating-box', '');
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const ends = [...slot.children, ...bar.querySelectorAll(':scope > .mrx-header-filter-bar-controls')]
      .filter((end): end is HTMLElement => end !== held && end instanceof HTMLElement);
    let room = 0;
    for (const end of ends.reverse()) {
      end.setAttribute('data-floating-end', '');
      end.style.setProperty('--mrx-floating-end', `${room}px`);
      if (end.offsetWidth > 0) room += end.offsetWidth + gap;
    }
    box.style.setProperty('--mrx-floating-ends-width', `${room}px`);
    const input = held.querySelector('input');
    setField(input?.value || held.querySelector('.mantine-Pill-root') ? 'filled' : 'empty');
  }, [box]);

  // After every render, since what the row holds is the page's; and as its parts change size.
  useLayoutEffect(arrange);
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(arrange);
    for (const part of box.querySelectorAll('.mrx-header-filter-bar-input > *, .mrx-header-filter-bar-controls')) observer.observe(part);
    return () => observer.disconnect();
  }, [box, arrange]);

  // The visible height drops by the keyboard as it opens and comes back as it closes.
  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (!typing || !viewport) return;
    const full = viewport.height;
    let opened = false;
    const follow = () => {
      if (full - viewport.height > KEYBOARD_HEIGHT) opened = true;
      else if (opened) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && boxRef.current?.contains(active)) active.blur();
      }
    };
    viewport.addEventListener('resize', follow);
    return () => viewport.removeEventListener('resize', follow);
  }, [typing]);

  useEffect(() => {
    floatingControlsShown.value = mounted;
    document.documentElement.classList.toggle('mrx-floating', mounted);
  }, [mounted]);
  useEffect(() => {
    floatingControlsTyping.value = typing;
  }, [typing]);
  useEffect(() => () => {
    floatingControlsShown.value = false;
    floatingControlsTyping.value = false;
    document.documentElement.classList.remove('mrx-floating');
  }, []);

  const { search } = useLocation();
  const askedFrom = useRef(search);
  useEffect(() => {
    if (search === askedFrom.current) return;
    askedFrom.current = search;
    const active = document.activeElement;
    if (active instanceof HTMLElement && boxRef.current?.contains(active)) active.blur();
  }, [search]);

  return (
    <Portal>
      <Transition mounted={mounted} transition={RISE} duration={RISE_DURATION} timingFunction={RISE_EASE}>
        {(styles) => (
          <Box
            ref={(node: HTMLDivElement | null) => {
              boxRef.current = node;
              setBox(node);
            }}
            className='mrx-floating-controls'
            style={styles}
            data-typing={typing || undefined}
            data-folded={(field === 'empty' && !typing) || undefined}
            onFocus={(event: FocusEvent) => typingIn(event) && setTyping(true)}
            onBlur={(event: FocusEvent) => typingIn(event) && setTyping(false)}
          >
            <Box className='mrx-floating-controls-row'>{children}</Box>
          </Box>
        )}
      </Transition>
    </Portal>
  );
}
