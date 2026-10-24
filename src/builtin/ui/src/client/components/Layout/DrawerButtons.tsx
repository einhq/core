import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { DRAWER_BESIDE_QUERY, drawerShows, type ResolvedTopbarEntry, toggleDrawer, uiNav } from '@ein/ui/signals';
import { usePhone } from '../../hooks/usePhone.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/** The top bar's entries that open a drawer, with the route each opens. */
const drawerEntries = (): { entry: ResolvedTopbarEntry; route: string }[] =>
  uiNav.value.topbar.flatMap((entry) => entry.action && 'drawer' in entry.action ? [{ entry, route: entry.action.drawer }] : []);

/**
 * The top bar's drawer buttons (the chat's), for a full-screen route that covers the top bar:
 * the drawer stays beside it there, and these open and close it. Only where the drawer is beside
 * the route rather than under it, below `md` it would open out of sight.
 */
export function DrawerButtons({ iconSize = 20, activeColor = 'var(--mrx-accent)' }: { iconSize?: number; activeColor?: string }) {
  useSignals();
  const wide = useMediaQuery(DRAWER_BESIDE_QUERY, false, { getInitialValueInEffect: false });
  if (!wide) return null;
  return drawerEntries().map(({ entry, route }) => {
    const open = drawerShows(route);
    return (
      <Tooltip key={entry.id} label={entry.title} withArrow>
        <ActionIcon
          variant='subtle'
          color='gray'
          size='lg'
          onClick={() => toggleDrawer(route)}
          aria-label={entry.title}
          aria-pressed={open}
          style={{ pointerEvents: 'auto' }}
        >
          <TablerIcon name={entry.icon} size={iconSize} style={{ color: open ? activeColor : 'white' }} />
        </ActionIcon>
      </Tooltip>
    );
  });
}

/**
 * The same entries as rows of a full-screen route's menu, for a phone, whose row of buttons has no
 * room for them: there they open the route in the dialog, over the full-screen route
 * (`toggleDrawer`). None elsewhere, where `DrawerButtons` stand.
 */
export function DrawerMenuItems({ iconSize = 14 }: { iconSize?: number }) {
  useSignals();
  const phone = usePhone();
  if (!phone) return null;
  return drawerEntries().map(({ entry, route }) => (
    <Menu.Item
      key={entry.id}
      leftSection={<TablerIcon name={entry.icon} size={iconSize} />}
      onClick={() => toggleDrawer(route)}
    >
      {entry.title}
    </Menu.Item>
  ));
}
