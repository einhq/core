import { getDefaultZIndex, Kbd, Loader, Modal, ScrollArea, TextInput } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useState } from 'react';
import { openFinder, paletteOpen } from '../../signals/palette.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { FinderHint, FinderRows } from './FinderRows.tsx';
import { useFinder } from './useFinder.tsx';

/**
 * Mod+K from anywhere: the top bar's search box, or where that cannot be reached — under a
 * dialog, the lightbox or another full-screen route, for a visitor held to a share link — the
 * same finder (`useFinder`) in a dialog of its own. Escape closes it.
 */
export function CommandPalette() {
  useSignals();
  const open = paletteOpen.value;
  const [query, setQuery] = useState('');
  const close = () => {
    paletteOpen.value = false;
  };
  const finder = useFinder(query, open, close);

  useHotkeys([['mod+K', () => (paletteOpen.value ? close() : openFinder())]], []);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    // Over the dialog or full-screen route it is opened over: those are modals too, mounted after
    // this one, so at the same level they would cover it.
    <Modal
      opened={open}
      onClose={close}
      withCloseButton={false}
      size='lg'
      yOffset='12vh'
      padding={0}
      radius='md'
      className='mrx-palette'
      zIndex={getDefaultZIndex('overlay')}
    >
      <TextInput
        data-autofocus
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={finder.onKeyDown}
        placeholder='Search, or go to a page…'
        size='lg'
        variant='unstyled'
        px='md'
        leftSection={<TablerIcon name='search' size={20} />}
        rightSection={finder.loading ? <Loader size={16} /> : <Kbd size='xs'>Esc</Kbd>}
        rightSectionWidth={56}
        aria-label='Find'
      />
      <ScrollArea.Autosize mah='60vh' type='auto' className='mrx-palette-list'>
        <FinderRows finder={finder} />
      </ScrollArea.Autosize>
      <FinderHint finder={finder} />
    </Modal>
  );
}
