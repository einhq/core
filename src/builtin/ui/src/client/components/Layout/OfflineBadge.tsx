import { Badge, Button, Popover, Stack, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconCloudOff, IconPlugConnectedX, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { formatDateTime } from '../../lib/datetime.ts';
import { agoText } from '../../lib/device-format.ts';
import { reconnectNow, savedAnswerShown, shellClientConnected, shellUnreachable } from '../../signals/shell-client.ts';

/** How often the age it gives is written again. */
const TICK_MS = 60_000;

/**
 * The top bar's word on the page's own connection, while it is down: Reconnecting while the socket
 * is being opened again, Offline once EiN is out of reach, and then, when the page shows what this
 * device saved, how old that is. A press says what it means and tries again.
 */
export function OfflineBadge({ phone }: { phone: boolean }) {
  useSignals();
  const location = useLocation();
  const [now, setNow] = useState(Date.now);
  const connected = shellClientConnected.value;
  useEffect(() => {
    if (connected) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => globalThis.clearInterval(timer);
  }, [connected]);
  if (connected) return null;

  const offline = shellUnreachable.value;
  const shown = savedAnswerShown.value;
  const savedAt = offline && shown?.path === location.pathname ? shown.at : undefined;
  const age = savedAt === undefined ? undefined : agoText(new Date(savedAt).toISOString(), now);
  const label = !offline ? 'Reconnecting' : age === undefined ? 'Offline' : phone ? age : `Offline · saved ${age}`;

  return (
    <Popover width={300} position='bottom-end' withArrow shadow='md'>
      <Popover.Target>
        <Badge
          component='button'
          type='button'
          size={phone ? 'md' : 'sm'}
          color={offline ? 'yellow' : 'red'}
          variant={offline ? 'light' : 'dot'}
          role='status'
          aria-label={offline ? `Offline${age === undefined ? '' : `, this page as saved ${age}`}` : 'Disconnected, reconnecting'}
          leftSection={offline ? <IconCloudOff size={phone ? 14 : 12} /> : phone ? <IconPlugConnectedX size={14} /> : undefined}
          styles={{ root: { cursor: 'pointer', color: offline ? undefined : 'white', textTransform: 'none' } }}
        >
          {phone && !offline ? null : label}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap='xs'>
          <Text fw={600} size='sm'>{offline ? 'EiN is out of reach' : 'Reconnecting to EiN'}</Text>
          <Text size='sm' c='dimmed'>
            {!offline
              ? 'The connection to EiN dropped. The page tries again by itself.'
              : savedAt !== undefined
              ? `This page is as it was saved on this device ${age}, on ${formatDateTime(savedAt)}. Nothing can be changed until the connection is back.`
              : 'Pages opened here while connected can be read without a connection. Nothing can be changed until it is back.'}
          </Text>
          <Button size='xs' variant='light' leftSection={<IconRefresh size={14} />} onClick={reconnectNow}>
            Try again
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
