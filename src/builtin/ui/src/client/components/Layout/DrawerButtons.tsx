import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { closeDialog, dialogPath, DRAWER_BESIDE_QUERY, drawerShows, openDialog, type ResolvedTopbarEntry, routeBase, toggleDrawer, uiNav } from '@ein/ui/signals';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/** The top bar's entries that open a drawer, with the route each opens. */
const drawerEntries = (): { entry: ResolvedTopbarEntry; route: string }[] =>
  uiNav.value.topbar.flatMap((entry) => entry.action && 'drawer' in entry.action ? [{ entry, route: entry.action.drawer }] : []);

/** Whether the dialog shows this route (or another under its base). */
const dialogShows = (route: string): boolean => dialogPath.value !== null && routeBase(dialogPath.value) === routeBase(route);

/**
 * Open a drawer's route from a full-screen route, or close it. From `md` the drawer stays beside the
 * full-screen route and the route opens there; below, full screen covers the drawer, so the route
 * opens in the dialog over it.
 */
const toggleOverFullscreen = (route: string): void => {
  if (globalThis.matchMedia(DRAWER_BESIDE_QUERY).matches) toggleDrawer(route);
  else if (dialogShows(route)) closeDialog();
  else openDialog(route);
};

/**
 * The top bar's drawer buttons (the chat's), for a full-screen route that covers the top bar: they
 * open and close the route beside it, or over it where the drawer would be out of sight beneath it
 * (`toggleOverFullscreen`). Where its row has no room for them, the route uses `DrawerMenuItems`.
 */
export function DrawerButtons({ iconSize = 20, activeColor = 'var(--mrx-accent)' }: { iconSize?: number; activeColor?: string }) {
  useSignals();
  const beside = useMediaQuery(DRAWER_BESIDE_QUERY, false, { getInitialValueInEffect: false });
  return drawerEntries().map(({ entry, route }) => {
    const open = beside ? drawerShows(route) : dialogShows(route);
    return (
      <Tooltip key={entry.id} label={entry.title} withArrow>
        <ActionIcon
          variant='subtle'
          color='gray'
          size='lg'
          onClick={() => toggleOverFullscreen(route)}
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

/** The same entries as rows of a full-screen route's menu, for a row of buttons with no room for them. */
export function DrawerMenuItems({ iconSize = 14 }: { iconSize?: number }) {
  useSignals();
  return drawerEntries().map(({ entry, route }) => (
    <Menu.Item
      key={entry.id}
      leftSection={<TablerIcon name={entry.icon} size={iconSize} />}
      onClick={() => toggleOverFullscreen(route)}
    >
      {entry.title}
    </Menu.Item>
  ));
}
