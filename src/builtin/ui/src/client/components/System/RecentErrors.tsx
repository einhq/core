import { Badge, Card, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { LogLine } from '@ein/api';

/** `dmesg` lines, oldest first, as it prints them. Absent until the first answer arrives. */
type Props = { errors?: LogLine[] };

/**
 * The time of day from the logger's `YYYY-MM-DD HH:MM:SS`. It is the server's local time with no
 * zone, so it is shown as written rather than parsed into the browser's.
 */
const timeLabel = (timestamp: string) => timestamp.slice(11) || timestamp;

/**
 * The last few things that went wrong.
 *
 * Message text only: the logger publishes `{level, name, message, timestamp}`
 * to /var/logs/system and drops the structured meta, so the step or instance a line
 * came from is not recoverable here — following one up still means `dmesg`.
 * What this answers is the prior question, "is anything wrong at all", which
 * otherwise requires knowing to go and look.
 */
export function RecentErrors({ errors: oldestFirst }: Props) {
  // Newest first: the question is what went wrong last.
  const errors = oldestFirst && [...oldestFirst].reverse();

  return (
    <Card>
      <Group gap='xs' mb='md'>
        <IconAlertTriangle size={18} />
        <Title order={4}>Recent problems</Title>
        {errors && errors.length > 0 && <Text size='sm' c='dimmed' ml='auto'>last {errors.length}</Text>}
      </Group>

      {!errors
        ? (
          <Stack gap='xs'>
            {[0, 1, 2].map((key) => <Skeleton key={key} height={14} />)}
          </Stack>
        )
        : errors.length === 0
        ? <Text c='dimmed'>Nothing logged at WARN or above</Text>
        : (
          <Stack gap='xs'>
            {errors.map((error, index) => (
              <Group key={`${error.timestamp}-${index}`} gap='xs' wrap='nowrap' align='flex-start'>
                <Badge size='xs' variant='light' color={error.level === 'ERROR' ? 'red' : 'yellow'} style={{ flexShrink: 0 }}>
                  {error.level}
                </Badge>
                <Text size='xs' c='dimmed' ff='monospace' style={{ flexShrink: 0 }}>{timeLabel(error.timestamp)}</Text>
                <Text size='xs' c='dimmed' ff='monospace' style={{ flexShrink: 0, maxWidth: 120 }} truncate>{error.name}</Text>
                <Text size='xs' style={{ minWidth: 0 }} lineClamp={2}>{error.message}</Text>
              </Group>
            ))}
          </Stack>
        )}
    </Card>
  );
}
