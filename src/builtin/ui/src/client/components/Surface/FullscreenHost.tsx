import { useSignals } from '@preact/signals-react/runtime';
import { closeFullscreen, fullscreenPath, routeBase } from '@ein/ui/signals';
import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { fullscreenRouteFromSearch } from '../../lib/fullscreen-search.ts';
import { SurfaceRouter } from './SurfaceRouter.tsx';

/**
 * The shell's full-screen surface, mounted once: the route the page's `?fullscreen=` names, over
 * everything. The URL is where it lives (`signals/surface.ts`); the signal follows it, and is
 * cleared at once by a close the URL has not caught up with. Keyed by the route's first
 * segment, so moving between pictures keeps the one router and the lightbox's state.
 */
export function FullscreenHost() {
  useSignals();
  const route = fullscreenRouteFromSearch(useLocation().search) ?? null;
  useLayoutEffect(() => {
    fullscreenPath.value = route;
  }, [route]);
  const path = fullscreenPath.value;
  if (!path) return null;
  return <SurfaceRouter key={routeBase(path)} kind='fullscreen' path={path} onClose={closeFullscreen} />;
}
