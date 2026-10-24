import { Box, Group, Skeleton, Stack, Text, ThemeIcon, Timeline, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { NewsEntry } from '@ein/api';
import { USERS_PATH } from '@ein/paths';
import { CoverAvatar, EmptyState, RoutePanel, TablerIcon } from '@ein/ui/components';
import { panelRoute, panelsOf } from '@ein/ui/signals';

const BULLET_SIZE = 44;

/** Who did it: the account's portrait through its `person` link, or the entry's icon. */
function NewsBullet({ entry }: { entry: NewsEntry }) {
  const icon = <TablerIcon name={entry.icon ?? 'news'} size={22} />;
  if (entry.by) {
    return (
      <CoverAvatar
        // The account's explicit archive identity; names are not unique and never pick a person.
        path={`${USERS_PATH}/${entry.by.username}/person`}
        fallback={icon}
        size={BULLET_SIZE - 2}
        alt={entry.by.name ?? entry.by.username}
        eager
      />
    );
  }
  return <ThemeIcon size={BULLET_SIZE - 2} radius='xl' variant='light' color='marine'>{icon}</ThemeIcon>;
}

/**
 * What has arrived lately (`news`), as a feed rather than a grid: one row per happening, newest
 * first, each drawn by the route of the module that told it, beside who did it. There is no
 * paging; the page shows a handful. `entries` is null until the answer is in, and stays null when
 * the command failed, which the page says above. With nothing yet, the `home.start` panels offer
 * a way to begin.
 */
export function HomeNews({ entries, loading }: { entries: NewsEntry[] | null; loading: boolean }) {
  useSignals();
  const start = panelsOf('home.start');

  return (
    <Stack gap='sm'>
      <Group gap='xs' align='center'>
        <TablerIcon name='news' size={18} style={{ color: 'var(--mrx-accent)' }} />
        <Title order={2} size='h4'>News</Title>
      </Group>

      {loading && entries === null && (
        <Stack gap='lg'>
          {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} height={100} radius='md' />)}
        </Stack>
      )}

      {entries?.length === 0 && (
        <EmptyState
          title='Nothing has been added yet'
          actions={start.length > 0 && start.map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} loading={null} failed={null} />)}
        >
          What people add shows up here.
        </EmptyState>
      )}

      {entries !== null && entries.length > 0 && (
        <Timeline bulletSize={BULLET_SIZE} lineWidth={2} color='marine' active={-1}>
          {entries.map((entry) => (
            <Timeline.Item key={`${entry.source}\n${entry.route}`} bullet={<NewsBullet entry={entry} />}>
              <Box pb='xs' style={{ minWidth: 0 }}>
                <RoutePanel path={entry.route} loading={<Skeleton height={100} radius='md' />} failed={<Text size='sm'>{entry.title}</Text>} />
              </Box>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </Stack>
  );
}
