import { Button, CloseButton, Group, Stack, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { Link } from 'react-router-dom';
import type { RecentSearch } from '../../lib/recent-searches.ts';
import { panelRoute, panelsOf } from '../../signals/nav.ts';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { RoutePanel } from '../Surface/SurfaceRouter.tsx';
import { ExploreSection } from './ExploreSection.tsx';

type SearchLandingProps = {
  recent: RecentSearch[];
  onForget: (params: string) => void;
  onClear: () => void;
};

/**
 * The Search page before anything is asked: the reader's recent searches, then the sections the
 * modules give the `search.explore` slot — the people, locations, years and labels worth starting
 * from — each a module's route drawing its own row.
 */
export function SearchLanding({ recent, onForget, onClear }: SearchLandingProps) {
  useSignals();
  const panels = panelsOf('search.explore');

  return (
    <Stack gap='xl'>
      {recent.length > 0 && (
        <ExploreSection icon='history' title='Recent searches'>
          <Group gap='xs'>
            {recent.map((search) => (
              <Group key={search.params} gap={0} wrap='nowrap' className='mrx-recent-search'>
                <Button component={Link} to={`/search?${search.params}`} variant='light' size='xs' leftSection={<TablerIcon name='search' size={14} />}>
                  {search.label}
                </Button>
                <CloseButton size='sm' aria-label={`Forget ${search.label}`} onClick={() => onForget(search.params)} />
              </Group>
            ))}
            <Button variant='subtle' size='xs' color='gray' onClick={onClear}>Clear</Button>
          </Group>
        </ExploreSection>
      )}

      {panels.map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} />)}

      {recent.length === 0 && panels.length === 0 && (
        <EmptyState title='Search for anything'>
          <Text span size='sm'>Type a name, a year or a few words; @ picks something by name.</Text>
        </EmptyState>
      )}
    </Stack>
  );
}
