import { Box } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { closeDrawer, DRAWER_BESIDE_QUERY, DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH, drawerPath, drawerWidth, setDrawerWidth } from '@ein/ui/signals';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom';
import { drawerOfEntry } from '../../lib/drawer-entry.ts';
import { SurfaceRouter } from '../Surface/SurfaceRouter.tsx';

/**
 * Where the drawer covers the page, it is what the page's history entry says (`openDrawer`): Back
 * and Forward bring it to the entry they step to, and another page opened over it — a link out of
 * the chat — closes it, so the page never changes out of sight beneath it. A replace that keeps
 * the page's path (a filter or a picture written to the URL) leaves it as it is.
 */
function useDrawerFollowsHistory() {
  const beside = useMediaQuery(DRAWER_BESIDE_QUERY, false, { getInitialValueInEffect: false });
  const location = useLocation();
  const step = useNavigationType();
  const shownPath = useRef(location.pathname);
  useEffect(() => {
    const inPlace = step === NavigationType.Replace && location.pathname === shownPath.current;
    shownPath.current = location.pathname;
    if (!beside && !inPlace) drawerPath.value = drawerOfEntry(location.state);
  }, [location.key]);
}

/**
 * The shell's side drawer, in the app shell's aside: the route `openDrawer` was given,
 * behind a handle that resizes it by pointer or arrow keys.
 */
export function DrawerHost() {
  useSignals();
  useDrawerFollowsHistory();
  const path = drawerPath.value;
  if (!path) return null;

  const maximumWidth = () => {
    const main = document.querySelector<HTMLElement>('.mantine-AppShell-main');
    const contentStart = main ? Number.parseFloat(getComputedStyle(main).paddingInlineStart) : 0;
    return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, globalThis.innerWidth - contentStart - 320));
  };

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    setDrawerWidth(Math.min(maximumWidth(), globalThis.innerWidth - event.clientX));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setDrawerWidth(Math.min(maximumWidth(), drawerWidth.value + (event.key === 'ArrowLeft' ? 20 : -20)));
  };

  return (
    <Box className='mrx-drawer' pos='relative' w='100%' h='100%'>
      <Box
        className='mrx-drawer-resize-handle'
        role='separator'
        aria-label='Resize side panel'
        aria-orientation='vertical'
        aria-valuemin={DRAWER_MIN_WIDTH}
        aria-valuemax={DRAWER_MAX_WIDTH}
        aria-valuenow={drawerWidth.value}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={resize}
        onKeyDown={resizeWithKeyboard}
      />
      <SurfaceRouter key={path} kind='drawer' path={path} onClose={closeDrawer} />
    </Box>
  );
}
