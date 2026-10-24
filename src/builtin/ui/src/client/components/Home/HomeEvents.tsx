import { Badge, Box, Group, Paper, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { EventEntry } from '@ein/api';
import { RoutePanel, TablerIcon } from '@ein/ui/components';

const MS_PER_DAY = 86_400_000;

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/**
 * When it happens, in the words a person would use.
 *
 * Days out to a fortnight, because that is the range where "in nine days" is
 * something you can act on. Past it the exact count stops mattering and weeks
 * read better — and starting weeks at fourteen days is also what keeps the
 * rounding from ever producing "in 1 weeks".
 */
const whenLabel = (daysAway: number): string => {
  if (daysAway === 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  if (daysAway === -1) return 'Yesterday';

  const days = Math.abs(daysAway);
  const ahead = daysAway > 0;
  if (days < 14) return ahead ? `in ${days} days` : `${days} days ago`;

  const weeks = Math.round(days / 7);
  return ahead ? `in ${weeks} weeks` : `${weeks} weeks ago`;
};

/** One entry: the providing module's route, and when it falls beside it. */
function EventRow({ entry, daysAway }: { entry: EventEntry; daysAway: number }) {
  const today = daysAway === 0;
  return (
    <Group gap='xs' wrap='nowrap' justify='space-between' align='center'>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <RoutePanel path={entry.route} loading={<Skeleton height={34} radius='xl' />} failed={<Text size='sm' lineClamp={2}>{entry.title}</Text>} />
      </Box>
      <Text size='xs' c={today ? 'var(--mrx-accent)' : 'dimmed'} fw={today ? 600 : undefined} style={{ flex: '0 0 auto' }}>
        {whenLabel(daysAway)}
      </Text>
    </Group>
  );
}

function Section({ label, entries, today }: { label: string; entries: EventEntry[]; today: string }) {
  if (entries.length === 0) return null;

  return (
    <Stack gap={8}>
      <Text size='xs' c='dimmed' fw={600} tt='uppercase' lts={0.5}>{label}</Text>
      {entries.map((entry) => <EventRow key={`${entry.source}\n${entry.route}`} entry={entry} daysAway={daysBetween(today, entry.date)} />)}
    </Stack>
  );
}

/**
 * What falls on the days either side of `today` (`events`): today, then what is coming — the ones
 * somebody can still do something about — and under them what has just passed, most recent first.
 * `entries` is null until the answer is in, and stays null when the command failed, which the page
 * says above; then nothing is drawn here.
 */
export function HomeEvents({ entries, loading, today }: { entries: EventEntry[] | null; loading: boolean; today: string }) {
  if (entries === null) return loading ? <Skeleton height={220} radius='md' /> : null;

  if (entries.length === 0) {
    return (
      <Paper p='md' radius='md' bg='var(--mrx-surface-raised)'>
        <Group gap='xs'>
          <TablerIcon name='calendar-heart' size={18} style={{ color: 'var(--mrx-text-tertiary)' }} />
          <Text c='dimmed' size='sm'>Nothing comes round in the next few weeks.</Text>
        </Group>
      </Paper>
    );
  }

  const away = (entry: EventEntry) => daysBetween(today, entry.date);
  // The answer is in date order, which runs oldest first through the past; read backwards, the
  // nearest miss comes first.
  const recent = entries.filter((entry) => away(entry) < 0).toReversed();

  return (
    <Paper p='md' radius='md' bg='var(--mrx-surface-raised)'>
      <Stack gap='md'>
        <Group gap='xs' align='center'>
          <TablerIcon name='calendar-heart' size={18} style={{ color: 'var(--mrx-accent)' }} />
          <Title order={2} size='h4'>Events</Title>
          <Badge variant='light' color='gray' size='sm'>{entries.length}</Badge>
        </Group>

        <Section label='Today' entries={entries.filter((entry) => away(entry) === 0)} today={today} />
        <Section label='Coming up' entries={entries.filter((entry) => away(entry) > 0)} today={today} />
        <Section label='Recently' entries={recent} today={today} />
      </Stack>
    </Paper>
  );
}
