import { SYSTEM_LOG_PATH } from '@ein/paths';
import { ActionIcon, Badge, Card, Group, ScrollArea, SegmentedControl, Text, Title, Tooltip } from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay, IconTerminal2, IconTrash } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef, useState } from 'react';
import { type LogLine, useLogTail } from '@ein/ui/hooks';

/** Levels in severity order; a filter selects this level and everything above it. */
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type Level = typeof LEVELS[number];

const RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const LEVEL_COLOR: Record<string, string> = { ERROR: 'red', WARN: 'yellow', DEBUG: 'gray' };

const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Distance from the bottom still counted as "at the bottom", in px. */
const STICK_PX = 40;

type Props = { path?: string; height?: number };

/**
 * A live tail of the system log.
 *
 * Pushed over the API socket the page already has, not polled: the server blocks
 * on the log's own notifications and sends batches as they land. The panel above
 * this one answers "is anything wrong"; this one answers "what is it doing right
 * now", which is otherwise only reachable by opening a terminal.
 *
 * Auto-scroll sticks to the bottom only while the reader is already there.
 * Scrolling up to read something is a deliberate act and a new line arriving must
 * not yank the view away from it.
 */
export function LogTail({ path = SYSTEM_LOG_PATH, height = 420 }: Props) {
  // useLogTail keys its subscription on shellClientEpoch; without tracking that
  // signal here a reconnect would leave the panel silently dead.
  useSignals();
  const [paused, setPaused] = useState(false);
  const [minLevel, setMinLevel] = useState<Level>('INFO');
  const { lines, connected, clear } = useLogTail(path, paused);

  const viewport = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const visible = lines.filter((line) => (RANK[line.level] ?? 1) >= RANK[minLevel]);

  useEffect(() => {
    if (!stuck.current) return;
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible.length]);

  const onScroll = () => {
    const node = viewport.current;
    if (!node) return;
    stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
  };

  return (
    <Card>
      <Group gap='xs' mb='md' wrap='nowrap'>
        <IconTerminal2 size={18} />
        <Title order={4}>Live log</Title>
        <Text size='xs' c='dimmed' ff='monospace'>{path}</Text>

        <Group gap='xs' ml='auto' wrap='nowrap'>
          {!connected && <Badge size='xs' color='yellow' variant='light'>connecting</Badge>}
          {paused && <Badge size='xs' color='blue' variant='light'>paused</Badge>}
          <SegmentedControl
            size='xs'
            value={minLevel}
            onChange={(value) => setMinLevel(value as Level)}
            data={LEVELS.map((level) => ({ label: level, value: level }))}
          />
          <Tooltip label={paused ? 'Resume' : 'Pause — the stream stays open, new lines are dropped'} withArrow>
            <ActionIcon variant='subtle' onClick={() => setPaused((value) => !value)} aria-label={paused ? 'Resume' : 'Pause'}>
              {paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label='Clear' withArrow>
            <ActionIcon variant='subtle' onClick={clear} aria-label='Clear'>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <ScrollArea h={height} viewportRef={viewport} onScrollPositionChange={onScroll}>
        {visible.length === 0
          ? <Text c='dimmed' size='sm'>{connected ? `Nothing at ${minLevel} or above yet` : 'Waiting for the stream'}</Text>
          : visible.map((line) => <Line key={line.id} line={line} />)}
      </ScrollArea>
    </Card>
  );
}

function Line({ line }: { line: LogLine }) {
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start' mb={2}>
      <Text size='xs' c='dimmed' ff='monospace' style={{ flexShrink: 0 }}>{timeLabel(line.at)}</Text>
      <Badge size='xs' variant='light' color={LEVEL_COLOR[line.level] ?? 'blue'} style={{ flexShrink: 0, width: 52 }}>
        {line.level}
      </Badge>
      <Text size='xs' c='dimmed' ff='monospace' style={{ flexShrink: 0, width: 130 }} truncate>{line.name}</Text>
      <Text size='xs' ff='monospace' style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.message}</Text>
    </Group>
  );
}
