import { Box, Group, Kbd, Text, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { Fragment } from 'react';
import { keyCaps } from '../../signals/shortcuts.ts';

/** One key and what it does now; `keys` as `useShortcutHelp` writes them (`shift+M`, `Enter`). */
export type LegendEntry = {
  keys: string;
  /** What the key does with what is on screen: "Name the album", not "Promote". */
  label: string;
  /** Clicking the entry does what the key does. */
  onClick?: () => void;
};

export type ShortcutLegendProps = {
  entries: readonly LegendEntry[];
  /** Collapsed to one "Keys" chip that brings the line back. */
  hidden?: boolean;
  /** "hide", and the chip, change it; without it the line cannot be hidden. */
  onHiddenChange?: (hidden: boolean) => void;
  /** Read out by a screen reader as it changes (`aria-live="polite"`): what was just done, and what is next. */
  announce?: string;
};

/**
 * The keys of what is on screen, as one docked line a reader keeps in sight while working: each
 * entry its key caps and what the key does now, and each a button doing the same. The page binds
 * the keys itself and lists them for the `?` overlay too (`useShortcutHelp`); this only shows
 * them. The page docks it (sticky at the foot of its column).
 */
export function ShortcutLegend({ entries, hidden = false, onHiddenChange, announce }: ShortcutLegendProps) {
  return (
    <Box className='mrx-shortcut-legend'>
      <VisuallyHidden aria-live='polite'>{announce ?? ''}</VisuallyHidden>
      {hidden
        ? (
          <UnstyledButton className='mrx-shortcut-legend-entry' onClick={() => onHiddenChange?.(false)} aria-label='Show the keys'>
            <Kbd size='xs'>?</Kbd>
            <Text size='xs' fw={500}>Keys</Text>
          </UnstyledButton>
        )
        : (
          <Group gap={6} wrap='wrap' align='center'>
            {entries.map((entry) => (
              <UnstyledButton
                key={`${entry.keys}:${entry.label}`}
                className='mrx-shortcut-legend-entry'
                onClick={entry.onClick}
                // A click leaves the focus where it was, so Enter afterwards is still the page's
                // key rather than this entry's.
                onMouseDown={(event) => event.preventDefault()}
                disabled={!entry.onClick}
              >
                <Group gap={2} wrap='nowrap'>
                  {keyCaps(entry.keys).map((cap, i) => (
                    <Fragment key={i}>
                      {i > 0 && <Text size='xs' c='dimmed'>+</Text>}
                      <Kbd size='xs'>{cap}</Kbd>
                    </Fragment>
                  ))}
                </Group>
                <Text size='xs' truncate>{entry.label}</Text>
              </UnstyledButton>
            ))}
            {onHiddenChange && (
              <UnstyledButton className='mrx-shortcut-legend-hide' onClick={() => onHiddenChange(true)}>
                <Text size='xs' c='dimmed'>hide</Text>
              </UnstyledButton>
            )}
          </Group>
        )}
    </Box>
  );
}
