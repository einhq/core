import { ActionIcon, AppShell, Box, Collapse, Divider, NavLink, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { IconChevronDown, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import { type NavLink as NavEntry, type ResolvedSection, uiNav } from '@ein/ui/signals';
import { Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePersistedState } from '../../hooks/usePersistedState.ts';
import { HatField } from '../EntityDetail/HatField.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

type AppNavbarProps = {
  /** Icons only: the rail beside the page. */
  rail: boolean;
  onNavigate: () => void;
  /** Switch between the rail and the labelled list. */
  onToggleRail: () => void;
};

type NavItemProps = NavEntry & { rail: boolean; isActive: boolean; onNavigate: () => void };

function NavItem({ icon, label, to, rail, isActive, onNavigate }: NavItemProps) {
  const navigate = useNavigate();
  const handleClick = () => {
    navigate(to);
    onNavigate();
  };

  if (rail) {
    // Larger than the labelled list's glyphs: in the rail the icon is all there
    // is to read, and below `sm` it is a finger's target. With no label to
    // brighten, the active glyph takes the accent colour while the rest stay
    // muted, on the same raised surface and accent bar as the labelled list.
    return (
      <Tooltip label={label} position='right' withArrow>
        <ActionIcon
          variant='subtle'
          color='gray'
          size={44}
          radius='md'
          aria-label={label}
          aria-current={isActive ? 'page' : undefined}
          onClick={handleClick}
          style={{
            color: isActive ? 'var(--mrx-accent)' : 'var(--mrx-text-tertiary)',
            background: isActive ? 'var(--mrx-surface-raised)' : undefined,
            boxShadow: isActive ? 'inset 3px 0 0 var(--mrx-accent)' : undefined,
            transition: 'color var(--mrx-dur-fast) var(--mrx-ease), background var(--mrx-dur-fast) var(--mrx-ease)',
          }}
        >
          <TablerIcon name={icon} size={24} stroke={1.75} />
        </ActionIcon>
      </Tooltip>
    );
  }

  return (
    <NavLink
      label={label}
      leftSection={<TablerIcon name={icon} size={20} />}
      active={isActive}
      aria-current={isActive ? 'page' : undefined}
      onClick={handleClick}
      variant='subtle'
      color='marine'
      styles={{
        root: {
          borderRadius: 'var(--mantine-radius-sm)',
          // The active item is marked by an accent bar rather than a filled block:
          // the accent stays a detail, and the nav does not compete with the media.
          borderLeft: `2px solid ${isActive ? 'var(--mrx-accent)' : 'transparent'}`,
          background: isActive ? 'var(--mrx-surface-raised)' : undefined,
          transition: 'background var(--mrx-dur-fast) var(--mrx-ease), border-color var(--mrx-dur-fast) var(--mrx-ease)',
        },
        label: { color: isActive ? 'var(--mrx-text-primary)' : 'var(--mrx-text-secondary)' },
        section: { color: isActive ? 'var(--mrx-accent)' : 'var(--mrx-text-tertiary)' },
      }}
    />
  );
}

/**
 * The entry a path belongs to: the longest `to` it starts with, so that
 * `/system/nodes` lights Nodes and not also Dashboard at `/system`.
 */
function activeEntry(sections: ResolvedSection[], pathname: string): string | undefined {
  let best: string | undefined;
  for (const section of sections) {
    for (const { to } of section.items) {
      const matches = pathname === to || (to !== '/' && pathname.startsWith(`${to}/`));
      if (matches && (best === undefined || to.length > best.length)) best = to;
    }
  }
  return best;
}

/** A labelled group's heading, which folds the group away. */
function SectionHeading({ label, open, first, onToggle }: { label: string; open: boolean; first: boolean; onToggle: () => void }) {
  return (
    <UnstyledButton
      onClick={onToggle}
      aria-expanded={open}
      mt={first ? 0 : 'sm'}
      mb={4}
      px={4}
      py={4}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 'var(--mantine-radius-sm)' }}
    >
      <Text size='xs' c='dimmed' fw={500} tt='uppercase'>{label}</Text>
      <IconChevronDown
        size={14}
        color='var(--mrx-text-tertiary)'
        style={{ transform: open ? undefined : 'rotate(-90deg)', transition: 'transform var(--mrx-dur-fast) var(--mrx-ease)' }}
      />
    </UnstyledButton>
  );
}

/**
 * The sidebar: the sections and pages `ui-nav` gives, which every module adds its own
 * pages to (each module's `ui/nav.json`; the shell's is `src/client/nav.json`).
 *
 * The shell's own entries are grouped by what you came to do, not by what exists: a
 * home, then querying the archive, then walking its collections, then operating the
 * thing. A flat list of eighteen has to be read; four short groups can be scanned.
 */
export function AppNavbar({ rail, onNavigate, onToggleRail }: AppNavbarProps) {
  useSignals();
  const location = useLocation();
  const navSections = uiNav.value.sections;
  const active = activeEntry(navSections, location.pathname);
  // The folded groups, by section id. A string because that is what the persisted
  // state holds; ids have no commas.
  const [foldedList, setFoldedList] = usePersistedState<string>('nav.folded', '');
  const folded = new Set(foldedList.split(',').filter(Boolean));
  const toggleFolded = (label: string) => {
    const next = new Set(folded);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setFoldedList([...next].join(','));
  };

  return (
    <>
      <Box className='mrx-sidebar-foot'>
        <HatField pattern='neutral' kind='foot' />
      </Box>
      <AppShell.Section grow component={ScrollArea} scrollbarSize={6} type='scroll'>
        <Stack gap={rail ? 6 : 4} p={rail ? 'xs' : 'md'} align={rail ? 'center' : 'stretch'}>
          {navSections.map((section, index) => {
            const open = !section.label || !folded.has(section.id);

            // The rail shows every icon whatever is folded: it has no headings
            // to unfold from, and a glyph costs it no room worth saving. A rule
            // stands in for the heading so the grouping still reads.
            if (rail) {
              return (
                <Fragment key={section.id}>
                  {index > 0 && <Divider my={4} w='70%' />}
                  {section.items.map((item) => <NavItem key={item.id} {...item} rail isActive={item.to === active} onNavigate={onNavigate} />)}
                </Fragment>
              );
            }

            // A folded group still shows the page you are on, so the sidebar
            // always says where you are.
            const current = open ? [] : section.items.filter((item) => item.to === active);

            return (
              <Fragment key={section.id}>
                {section.label && <SectionHeading label={section.label} open={open} first={index === 0} onToggle={() => toggleFolded(section.id)} />}
                <Collapse expanded={open} transitionDuration={150}>
                  <Stack gap={4}>
                    {section.items.map((item) => <NavItem key={item.id} {...item} rail={false} isActive={item.to === active} onNavigate={onNavigate} />)}
                  </Stack>
                </Collapse>
                {current.map((item) => <NavItem key={item.id} {...item} rail={false} isActive onNavigate={onNavigate} />)}
              </Fragment>
            );
          })}
        </Stack>
      </AppShell.Section>

      <AppShell.Section p={rail ? 'xs' : 'md'} pt={0}>
        <Divider mb='xs' />
        <Stack align={rail ? 'center' : 'flex-end'}>
          <Tooltip label={rail ? 'Show labels' : 'Collapse to icons'} position='right' withArrow>
            <ActionIcon
              variant='subtle'
              color='gray'
              size={rail ? 44 : 'lg'}
              radius='md'
              aria-label={rail ? 'Show labels' : 'Collapse to icons'}
              onClick={onToggleRail}
            >
              {rail ? <IconLayoutSidebarLeftExpand size={22} /> : <IconLayoutSidebarLeftCollapse size={20} />}
            </ActionIcon>
          </Tooltip>
        </Stack>
      </AppShell.Section>
    </>
  );
}
