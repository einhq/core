import { ActionIcon, type FloatingPosition, Menu, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { closeDialog, dialogPath, DRAWER_BESIDE_QUERY, drawerShows, openDialog, routeBase, toggleDrawer, uiNav } from '@ein/ui/signals';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/**
 * The entries that open a route in the drawer, with the route each opens: wherever they are drawn,
 * for a full-screen route that covers the top bar and the sidebar to offer them.
 */
const drawerEntries = (): { id: string; title: string; icon: string; route: string }[] => {
  const nav = uiNav.value;
  return [
    ...nav.topbar.flatMap((entry) => [entry, ...(entry.menu ?? [])]).map((entry) => ({ id: entry.id, title: entry.title, icon: entry.icon, action: entry.action })),
    ...nav.sections.flatMap((section) => section.items).map((link) => ({ id: link.id, title: link.label, icon: link.icon, action: link.action })),
  ].flatMap(({ action, ...entry }) => action && 'drawer' in action ? [{ ...entry, route: action.drawer }] : []);
};

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
 * The navigation's drawer buttons (the chat's), for a full-screen route that covers the top bar: they
 * open and close the route beside it, or over it where the drawer would be out of sight beneath it
 * (`toggleOverFullscreen`). Where its row has no room for them, the route uses `DrawerMenuItems`.
 * Their icons are `color`, and `activeColor` while their route is open; `hideOpen` leaves an open
 * one out instead, for a place where the drawer's own close button is enough.
 */
export function DrawerButtons(
  { iconSize = 20, color = 'white', activeColor = 'var(--mrx-accent)', hideOpen = false, tooltipPosition }: {
    iconSize?: number;
    color?: string;
    activeColor?: string;
    hideOpen?: boolean;
    tooltipPosition?: FloatingPosition;
  },
) {
  useSignals();
  const beside = useMediaQuery(DRAWER_BESIDE_QUERY, false, { getInitialValueInEffect: false });
  return drawerEntries().map(({ route, ...entry }) => {
    const open = beside ? drawerShows(route) : dialogShows(route);
    if (open && hideOpen) return null;
    return (
      <Tooltip key={entry.id} label={entry.title} position={tooltipPosition} withArrow>
        <ActionIcon
          variant='subtle'
          color='gray'
          size='lg'
          onClick={() => toggleOverFullscreen(route)}
          aria-label={entry.title}
          aria-pressed={open}
          style={{ pointerEvents: 'auto' }}
        >
          <TablerIcon name={entry.icon} size={iconSize} style={{ color: open ? activeColor : color }} />
        </ActionIcon>
      </Tooltip>
    );
  });
}

/** The same entries as rows of a full-screen route's menu, for a row of buttons with no room for them. */
export function DrawerMenuItems({ iconSize = 14 }: { iconSize?: number }) {
  useSignals();
  return drawerEntries().map(({ route, ...entry }) => (
    <Menu.Item
      key={entry.id}
      leftSection={<TablerIcon name={entry.icon} size={iconSize} />}
      onClick={() => toggleOverFullscreen(route)}
    >
      {entry.title}
    </Menu.Item>
  ));
}
