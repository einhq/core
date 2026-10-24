import { ActionIcon, Transition } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconArrowUp } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { scrollToTop } from '../../lib/scroll-to-top.ts';
import { floatingControlsShown, floatingControlsTyping } from '../../signals/floating-controls.ts';
import { RISE, RISE_DURATION, RISE_EASE } from './rise.ts';

/**
 * Back to the top of a long page, where the header's actions are: a round button in the lower
 * right. It shows once the page has scrolled a screen down, or with a page header's controls
 * floating beside it (`floatingControlsShown`), and comes and goes as they do (`RISE`). It makes
 * way while their box has the keyboard (`floatingControlsTyping`).
 */
export function BackToTop() {
  useSignals();
  const [scrolled, setScrolled] = useState(false);
  const shown = (scrolled || floatingControlsShown.value) && !floatingControlsTyping.value;

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setScrolled(globalThis.scrollY > globalThis.innerHeight);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      globalThis.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <Transition mounted={shown} transition={RISE} duration={RISE_DURATION} timingFunction={RISE_EASE}>
      {(styles) => (
        <ActionIcon className='mrx-to-top' style={styles} radius='50%' aria-label='Back to top' onClick={scrollToTop}>
          <IconArrowUp size={24} />
        </ActionIcon>
      )}
    </Transition>
  );
}
