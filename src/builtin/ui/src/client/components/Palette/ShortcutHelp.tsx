import { Group, Kbd, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { Fragment } from 'react';
import { useShortcutHelp } from '../../hooks/useShortcutHelp.ts';
import { keyCaps, shortcutGroups, shortcutHelpOpen, topbarShortcuts } from '../../signals/shortcuts.ts';
import { Dialog } from '../Surface/Dialog.tsx';

const ANYWHERE = 'Anywhere';

/**
 * `?` from anywhere outside a text field: the keys of what is on screen, grouped by the part of the
 * app that binds them (`useShortcutHelp`). The app's own keys are always listed, and with them the
 * top bar's, which modules give.
 */
export function ShortcutHelp() {
  useSignals();
  useHotkeys([['shift+?', () => (shortcutHelpOpen.value = !shortcutHelpOpen.value)]]);
  useShortcutHelp(ANYWHERE, [
    { keys: 'mod+K', label: 'Search, or go to a page, person or album; > for commands' },
    { keys: '?', label: 'These shortcuts' },
    { keys: 'alt+T', label: 'Show or hide the terminal' },
    { keys: 'alt+N', label: 'New terminal tab' },
  ]);

  // The same group mounted twice (two grids) is listed once.
  const topbar = topbarShortcuts().map(({ entry, label }) => ({ keys: entry.shortcut, label }));
  const groups = shortcutGroups.value
    .filter((entry, index, all) => all.findIndex((other) => other.group === entry.group) === index)
    .map((entry) => (entry.group === ANYWHERE ? { ...entry, entries: [...entry.entries, ...topbar] } : entry));

  return (
    <Dialog opened={shortcutHelpOpen.value} onClose={() => (shortcutHelpOpen.value = false)} title='Keyboard shortcuts' icon='keyboard' size='xl'>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='xl'>
        {groups.map(({ id, group, entries }) => (
          <Stack key={id} gap='xs'>
            <Title order={3} size='h6' c='dimmed' tt='uppercase'>{group}</Title>
            {entries.map((entry) => (
              <Group key={entry.keys} justify='space-between' wrap='nowrap' gap='md'>
                <Text size='sm'>{entry.label}</Text>
                <Group gap={4} wrap='nowrap'>
                  {keyCaps(entry.keys).map((cap, i) => (
                    <Fragment key={i}>
                      {i > 0 && <Text size='xs' c='dimmed'>+</Text>}
                      <Kbd size='sm'>{cap}</Kbd>
                    </Fragment>
                  ))}
                </Group>
              </Group>
            ))}
          </Stack>
        ))}
      </SimpleGrid>
    </Dialog>
  );
}
