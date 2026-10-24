import { Anchor, Box, Group, Title } from '@mantine/core';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

type ExploreSectionProps = {
  /** Tabler icon name before the title. */
  icon: string;
  title: ReactNode;
  /** Where "See all" goes; no link without it. */
  to?: string;
  children: ReactNode;
};

/**
 * One section of the Search page's landing: a titled row a module fills from its own command,
 * with a link to the page that has all of it.
 */
export function ExploreSection({ icon, title, to, children }: ExploreSectionProps) {
  return (
    <Box component='section' className='mrx-explore-section'>
      <Group justify='space-between' align='baseline' mb='sm' wrap='nowrap'>
        <Group gap={8} wrap='nowrap'>
          <TablerIcon name={icon} size={18} />
          <Title order={2} size='h4'>{title}</Title>
        </Group>
        {to && <Anchor component={Link} to={to} size='sm'>See all</Anchor>}
      </Group>
      {children}
    </Box>
  );
}

/**
 * A single line of items. With a mouse it shows only the items that fit whole; on a touch screen
 * it is swiped sideways to the rest. Items past the row's right edge are marked `data-beyond`,
 * which the theme hides only where there is a mouse.
 */
export function ExploreRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // Every render, since the items may have changed; the observer follows the row's width and theirs.
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const fit = () => {
      const edge = row.getBoundingClientRect().right + 0.5;
      for (const item of row.children) item.toggleAttribute('data-beyond', item.getBoundingClientRect().right > edge);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    for (const item of row.children) observer.observe(item);
    return () => observer.disconnect();
  });

  return <Box ref={ref} className='mrx-explore-row'>{children}</Box>;
}
