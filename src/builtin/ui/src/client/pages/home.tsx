import { Alert, Box, Container, Text } from '@mantine/core';
import type { EventEntry, NewsEntry, OnThisDayEntry } from '@ein/api';
import { EntityDetailHeader, TablerIcon } from '@ein/ui/components';
import { useCommand, useLocalDay } from '@ein/ui/hooks';
import { HomeEvents } from '../components/Home/HomeEvents.tsx';
import { HomeNews } from '../components/Home/HomeNews.tsx';
import { HomeOnThisDay } from '../components/Home/HomeOnThisDay.tsx';

/**
 * The page at `/`, edge to edge: the header band every listing page has, then this day in
 * earlier years, and under it news in the wider column with events beside it.
 *
 * Core names no module here. Each section is one core command gathering what the modules'
 * providers answer (`onthisday`, `news`, `events`; see `@ein/api`'s feeds), and each entry is
 * drawn by the route its provider names. Each section paints as its own command lands; a
 * page-wide spinner would hold all of it back for the slowest.
 */
export default function HomePage() {
  const today = useLocalDay();
  const onThisDay = useCommand<OnThisDayEntry[]>(`onthisday ${today.slice(5)}`);
  const news = useCommand<NewsEntry[]>('news');
  const events = useCommand<EventEntry[]>(`events --today ${today}`);
  const errors = [['onthisday', onThisDay.error], ['news', news.error], ['events', events.error]] as const;

  return (
    <Box className='mrx-home'>
      <EntityDetailHeader
        title='Welcome'
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            What is new in the archive, what is coming up, and this day in years past
          </Text>
        }
        flowContent
      />

      <Container px='md' py='md'>
        {errors.map(([section, error]) =>
          error && (
            <Alert key={section} mb='md' color='red' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />}>
              {error.message}
            </Alert>
          )
        )}
        <HomeOnThisDay entries={onThisDay.data} loading={onThisDay.loading} />
        <Box className='mrx-home-content'>
          <Box style={{ minWidth: 0 }}>
            <HomeNews entries={news.data} loading={news.loading} />
          </Box>
          <Box style={{ minWidth: 0 }}>
            <HomeEvents entries={events.data} loading={events.loading} today={today} />
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
