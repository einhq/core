import { ActionIcon, Badge, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useLogFollow } from '../../hooks/useLogFollow.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { formatWhen } from './NodeRow.tsx';
import type { LogStat, QueuePeekEntry, QueueStat, Wire } from '@ein/api';

type PeekedEntry = Wire<QueuePeekEntry>;
export type { LogStat, QueuePeekEntry, QueueStat } from '@ein/api';

/** How many entries the drawer shows of a log or a queue. */
const SHOWN = 15;

const LEVEL_COLOR: Record<string, string> = { ERROR: 'red', WARN: 'yellow', DEBUG: 'dimmed' };
/** What the logger writes besides the message; its `timestamp` is the entry's own time again. */
const LOGGER_KEYS = new Set(['level', 'name', 'message', 'timestamp']);

/**
 * An entry's text. A string is a line of text; what the logger writes —
 * `/var/logs/system` and the service logs — reads as `LEVEL name: message`;
 * anything else is the JSON it is.
 */
function EntryBody({ data }: { data: unknown }) {
  const text = { size: 'xs', ff: 'monospace', lineClamp: 6, style: { wordBreak: 'break-word', whiteSpace: 'pre-wrap' } } as const;
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { message?: unknown }).message === 'string') {
    const { level, name, message } = data as { level?: unknown; name?: unknown; message: string };
    const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !LOGGER_KEYS.has(key)));
    const levelText = typeof level === 'string' ? level : '';
    return (
      <Text {...text}>
        {levelText && <Text span inherit fw={600} c={LEVEL_COLOR[levelText]}>{levelText}</Text>}
        {levelText && ' '}
        {typeof name === 'string' && <Text span inherit c='dimmed'>{name}:</Text>} {message}
        {Object.keys(rest).length > 0 && <Text span inherit c='dimmed' ml={4}>{JSON.stringify(rest)}</Text>}
      </Text>
    );
  }
  return <Text {...text}>{typeof data === 'string' ? data : JSON.stringify(data)}</Text>;
}

/** One entry: when, above what. The drawer is too narrow for both on one line. */
function Entry({ at, badges, data }: { at: string; badges?: React.ReactNode; data: unknown }) {
  const when = Date.parse(at);
  return (
    <Stack gap={0} py={4} style={{ borderBottom: '1px solid var(--mrx-hairline)' }}>
      <Group gap={6} wrap='nowrap'>
        <Text size='xs' c='dimmed' ff='monospace'>{Number.isFinite(when) ? formatWhen(when) : at}</Text>
        {badges}
      </Group>
      <EntryBody data={data} />
    </Stack>
  );
}

/**
 * The last entries of a log, newest first, kept live: a log is read like a
 * file, and its end is the part anyone opens one for.
 */
export function LogPreview({ path }: { path: string }) {
  const { entries, connected } = useLogFollow(path, { tail: SHOWN, keep: SHOWN });
  const [stat, setStat] = useState<LogStat | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStat(null);
    execCommand<LogStat>(`file-stat ${shq(path)}`).then((found) => !cancelled && setStat(found)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Stack gap={4}>
      <Text size='xs' c='dimmed'>
        {stat ? `The last ${Math.min(SHOWN, stat.size)} of ${stat.size} entries, newest first` : `The last ${SHOWN} entries, newest first`}
        {stat?.retention ? `; kept ${stat.retention}` : ''}
      </Text>
      {!connected && entries.length === 0 && <Loader size='sm' />}
      {connected && entries.length === 0 && <Text size='sm' c='dimmed'>Empty</Text>}
      {[...entries].reverse().map((entry) => <Entry key={entry.id} at={entry.createdAt} data={entry.data} />)}
    </Stack>
  );
}

/**
 * The front of a queue, as a consumer would get it — peeked, not read: a read
 * of a queue claims what it reads, so looking would empty it.
 *
 * A queue raises no events as it fills and drains, so this is a snapshot with
 * a refresh rather than a live view.
 */
export function QueuePreview({ path }: { path: string }) {
  const [state, setState] = useState<{ stat: QueueStat; items: PeekedEntry[] } | { error: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      execCommand<QueueStat>(`file-stat ${shq(path)}`),
      execCommand<{ items: PeekedEntry[] }>(`queue-peek -n ${SHOWN} ${shq(path)}`),
    ]).then(([stat, { items }]) => !cancelled && setState({ stat, items }))
      .catch((err) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  if (!state) return <Loader size='sm' />;
  if ('error' in state) return <Text size='xs' c='red'>{state.error}</Text>;

  const { stat, items } = state;
  return (
    <Stack gap={4}>
      <Group gap={6} wrap='nowrap'>
        <Text size='xs' c='dimmed' style={{ flex: 1 }}>
          {stat.size} ready, {stat.inFlight} in flight{stat.deadLettered > 0 ? `, ${stat.deadLettered} dead-lettered` : ''}
          {items.length > 0 ? `; the next ${items.length}, not consumed` : ''}
        </Text>
        <Tooltip label='Refresh' withArrow>
          <ActionIcon variant='subtle' color='gray' size='sm' onClick={() => setTick((n) => n + 1)} aria-label='Refresh queue'>
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {stat.routingKeys.length > 0 && <Text size='xs' c='dimmed' ff='monospace' truncate title={stat.routingKeys.join(', ')}>← {stat.routingKeys.join(', ')}</Text>}
      {items.length === 0 && <Text size='sm' c='dimmed'>Empty</Text>}
      {items.map((item) => (
        <Entry
          key={item.id}
          at={item.createdAt}
          data={item.data}
          badges={
            <>
              {item.state === 'in-flight' && <Badge size='xs' color='yellow' variant='light'>in flight</Badge>}
              {item.attempts > (item.state === 'in-flight' ? 1 : 0) && <Badge size='xs' color='gray' variant='outline'>try {item.attempts}</Badge>}
              {/* `-` is an entry appended directly rather than routed to the queue. */}
              {item.routingKey !== '-' && <Text size='xs' c='dimmed' ff='monospace' truncate style={{ minWidth: 0 }}>{item.routingKey}</Text>}
            </>
          }
        />
      ))}
    </Stack>
  );
}
