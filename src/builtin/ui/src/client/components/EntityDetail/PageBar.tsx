import { Box, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { HatField, type HatPattern } from './HatField.tsx';

type PageBarProps = {
  title: ReactNode;
  /** Right-aligned beside the title; wraps onto a line of its own when the two do not fit. */
  controls?: ReactNode;
  /** The band's einstein-hat field; without one the bar is a plain band a shade lighter than the page. */
  pattern?: HatPattern;
  /** The page's `Tabs.List`, as `EntityDetailHeader` takes it: a second line on the bar's bottom edge. */
  tabs?: ReactNode;
  /**
   * The tabs run from edge to edge rather than lined up with the title: for
   * tabs that stand over columns of the body below, as the nodes explorer's
   * stand over its panes.
   */
  flushTabs?: boolean;
};

/**
 * The slim sibling of `EntityDetailHeader`: the same einstein-hat band, or a
 * plain one, one line high, for a page whose body is a tool that wants the height — the chat,
 * the map. The title sits at the left and the page's controls at the right, on
 * the band's dark ground rather than over the tool.
 */
export function PageBar({ title, controls, pattern, tabs, flushTabs }: PageBarProps) {
  return (
    <Box
      component='header'
      className={pattern ? 'mrx-page-bar mrx-pattern' : 'mrx-page-bar'}
      data-pattern={pattern}
    >
      {pattern && <HatField pattern={pattern} />}
      <Box className='mrx-page-bar-content'>
        <Title order={1} className='mrx-page-bar-title'>{title}</Title>
        {controls && <Box className='mrx-page-bar-controls'>{controls}</Box>}
      </Box>
      {tabs && <Box className='mrx-header-tabs' data-flush={flushTabs || undefined}>{tabs}</Box>}
    </Box>
  );
}
