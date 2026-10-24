import { Box, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { COMMAND_PREFIX, type Finder } from './useFinder.tsx';

/**
 * The finder's rows under their group headings, the active one lit. A press on a row does not
 * take focus from the box it was typed in, so a list that closes on blur stays open for the click.
 */
export function FinderRows({ finder }: { finder: Finder }) {
  const { items, active, setActive, loading, commandMode, commandTooShort, listRef } = finder;
  if (items.length === 0) {
    return (
      <Group p='md' gap='xs'>
        {loading && <Loader size={14} />}
        <Text c='dimmed' size='sm'>
          {loading ? 'Looking…' : commandTooShort ? 'Type what the command should do.' : commandMode ? 'No command matches.' : 'Nothing matches.'}
        </Text>
      </Group>
    );
  }

  let lastGroup = '';
  return (
    <Stack ref={listRef} gap={0} p='xs' onMouseDown={(event) => event.preventDefault()}>
      {items.map((item, index) => {
        const heading = item.group !== lastGroup ? item.group : undefined;
        lastGroup = item.group;
        return (
          <Box key={item.id}>
            {heading && <Text size='xs' c='dimmed' tt='uppercase' fw={600} px='sm' pt='sm' pb={4}>{heading}</Text>}
            <UnstyledButton
              data-index={index}
              data-active={index === active || undefined}
              className='mrx-palette-item'
              onMouseMove={() => setActive(index)}
              onClick={item.run}
            >
              <Group gap='sm' wrap='nowrap'>
                <Box c='dimmed' style={{ display: 'flex', flex: 'none' }}>{item.icon}</Box>
                <Text size='sm' truncate style={{ flex: 1 }}>{item.label}</Text>
                {item.detail && <Text size='xs' c='dimmed' truncate maw='45%'>{item.detail}</Text>}
              </Group>
            </UnstyledButton>
          </Box>
        );
      })}
    </Stack>
  );
}

/** The line under the rows that says how to reach the commands, while the query is not for them. */
export function FinderHint({ finder }: { finder: Finder }) {
  if (finder.commandMode) return null;
  return (
    <Text size='xs' c='dimmed' px='md' py={6} className='mrx-finder-hint' onMouseDown={(event) => event.preventDefault()}>
      Type <Text span ff='monospace' fw={600} inherit>{COMMAND_PREFIX}</Text> to find a command
    </Text>
  );
}
