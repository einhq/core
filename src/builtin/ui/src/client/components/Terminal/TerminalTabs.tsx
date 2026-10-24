import { ActionIcon, CloseButton, Group, Kbd, Popover, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { IconArrowsMaximize, IconArrowsMinimize, IconChevronUp, IconPlus, IconQuestionMark, IconTerminal2 } from '@tabler/icons-react';
import {
  activeTerminalTab,
  addTerminalTab,
  closeTerminalTab,
  switchTerminalTab,
  terminalHeight,
  terminalMaximizedToggle,
  terminalOpen,
  terminalOpenToggle,
  terminalTabs,
} from '@ein/ui/signals';
import { useEffect } from 'react';
import { HatField } from '../EntityDetail/HatField.tsx';

export function TerminalTabs() {
  useSignals();
  const [helpOpened, { toggle: toggleHelp, close: closeHelp }] = useDisclosure(false);
  const tabs = terminalTabs.value;
  const activeId = activeTerminalTab.value;
  const isOpen = terminalOpen.value;

  // Close help popover when terminal closes
  useEffect(() => {
    if (!isOpen) closeHelp();
  }, [isOpen, closeHelp]);

  return (
    <Group className='terminal-tab-bar' h={36} px='xs' gap={0} justify='space-between'>
      <HatField pattern='neutral' kind='foot' />
      <Group gap={0}>
        {tabs.map((tab) => (
          <UnstyledButton
            key={tab.id}
            onClick={() => switchTerminalTab(tab.id)}
            px='sm'
            py='xs'
            style={(theme) => ({
              backgroundColor: tab.id === activeId ? theme.colors.dark[7] : 'transparent',
              borderRight: '1px solid var(--mrx-hairline)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            })}
          >
            <IconTerminal2 size={14} />
            <Text size='xs' c={tab.id === activeId ? 'gray.3' : 'dimmed'}>
              {tab.pwd || tab.title}
            </Text>
            {tabs.length > 1 && (
              <CloseButton
                size='xs'
                variant='subtle'
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminalTab(tab.id);
                }}
              />
            )}
          </UnstyledButton>
        ))}

        <Tooltip label='New session (Alt+N)' zIndex={1200}>
          <ActionIcon
            variant='subtle'
            size='sm'
            mx='xs'
            onClick={() => addTerminalTab()}
            aria-label='New session'
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Group gap='xs'>
        <Tooltip label={terminalHeight.value === 100 ? 'Restore (Alt+M)' : 'Maximize (Alt+M)'} zIndex={1200}>
          <ActionIcon variant='subtle' size='sm' onClick={terminalMaximizedToggle} aria-label={terminalHeight.value === 100 ? 'Restore terminal' : 'Maximize terminal'}>
            {terminalHeight.value === 100 ? <IconArrowsMinimize size={14} /> : <IconArrowsMaximize size={14} />}
          </ActionIcon>
        </Tooltip>
        <Popover opened={helpOpened} onClose={closeHelp} position='top-end' shadow='md' width={220} zIndex={1200} withinPortal={false}>
          <Popover.Target>
            <ActionIcon variant='subtle' size='sm' onClick={toggleHelp} aria-label='Terminal shortcuts'>
              <IconQuestionMark size={14} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap='xs'>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>T</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Toggle terminal</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>N</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>New tab</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>W</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Close tab</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>M</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Maximize</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>←</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Previous tab</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>→</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Next tab</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>↑</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Shrink height</Text>
              </Group>
              <Group justify='space-between'>
                <Group gap={4}>
                  <Kbd size='xs'>Alt</Kbd>
                  <Kbd size='xs'>↓</Kbd>
                </Group>
                <Text size='xs' c='dimmed'>Grow height</Text>
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Tooltip label='Hide terminal (Alt+T)' zIndex={1200}>
          <ActionIcon variant='subtle' size='sm' onClick={terminalOpenToggle} aria-label='Hide terminal'>
            <IconChevronUp size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
