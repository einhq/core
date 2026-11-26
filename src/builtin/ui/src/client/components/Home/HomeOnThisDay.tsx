import { Box, Skeleton, Text, Title } from '@mantine/core';
import type { OnThisDayEntry } from '@ein/api';
import { RoutePanel, ScrollRow } from '@ein/ui/components';

/**
 * This calendar day in every earlier year (`onthisday --limit all`), as one row that scrolls
 * sideways (`ScrollRow`), newest year first, each entry drawn by the route of the module that has it. Absent when no earlier year has
 * anything, and when the command failed (`entries` stays null), which the page says above.
 */
export function HomeOnThisDay({ entries, loading }: { entries: OnThisDayEntry[] | null; loading: boolean }) {
  if (entries === null) return loading ? <Skeleton height={112} radius='md' mb='lg' /> : null;
  if (entries.length === 0) return null;

  return (
    <Box mb='lg'>
      <Title order={2} size='h4' mb='sm'>On this day</Title>
      <ScrollRow label='On this day'>
        {entries.map((entry) => (
          <Box key={`${entry.source}\n${entry.route}`} role='listitem'>
            <RoutePanel
              path={entry.route}
              loading={<Skeleton circle height={76} />}
              failed={<Text size='xs' w={84} lineClamp={3}>{entry.title}</Text>}
            />
          </Box>
        ))}
      </ScrollRow>
    </Box>
  );
}
