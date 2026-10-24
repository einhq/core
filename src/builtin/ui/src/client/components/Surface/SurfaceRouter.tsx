import { Box, Modal } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import {
  fullscreenBesideDrawer,
  fullscreenPath,
  leaveFullscreen,
  navigatePage,
  openFullscreen,
  routeBase,
  shellChildRoutes,
  type SurfaceKind,
  underBase,
} from '@ein/ui/signals';
import { awaitModuleRoutes, modulePatcher } from '../../signals/module-ui.ts';
import { type ComponentType, createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  type DataRouter,
  Outlet,
  type RouteObject,
  RouterProvider,
  UNSAFE_createMemoryHistory,
  UNSAFE_createRouter,
  UNSAFE_hydrationRouteProperties,
  UNSAFE_LocationContext,
  UNSAFE_mapRouteProperties,
  UNSAFE_RouteContext,
  useMatches,
} from 'react-router-dom';
import { type Surface, SurfaceContext } from '../../hooks/useSurface.ts';
import { RouteError } from '../RouteProblem/RouteProblem.tsx';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { Dialog, type DialogProps, type DialogSize } from './Dialog.tsx';
import type { HatPattern } from '../EntityDetail/HatField.tsx';

/**
 * What a route may say about itself for the dialog's frame: `export const handle = { title, icon, pattern }`,
 * `pattern` naming the pages of what the route makes, whose colour the dialog takes, and `dialogSize`
 * its width. `hero` draws a band of the route's own in place of the icon and title (`Dialog`'s
 * `hero`), `aside` controls of the route's own beside the title (`Dialog`'s `aside`), `bleed` a body
 * without padding for a route that runs to the dialog's edges, and `ground` is what the dialog
 * stands on.
 */
type SurfaceHandle = {
  title?: string;
  icon?: string;
  pattern?: HatPattern;
  dialogSize?: DialogSize | number;
  hero?: ComponentType;
  aside?: ComponentType;
  bleed?: boolean;
  ground?: DialogProps['ground'];
};

const useHandle = (): SurfaceHandle => {
  const handle: SurfaceHandle = {};
  for (const match of useMatches()) Object.assign(handle, match.handle ?? {});
  return handle;
};

function DialogFrame({ handle, children }: { handle: SurfaceHandle; children: ReactNode }) {
  const surface = useContext(SurfaceContext)!;
  const Hero = handle.hero;
  const Aside = handle.aside;
  return (
    <Dialog
      opened
      onClose={surface.close}
      title={handle.title ?? ''}
      icon={handle.icon}
      pattern={handle.pattern}
      size={handle.dialogSize ?? 'lg'}
      hero={Hero && <Hero />}
      aside={Aside && <Aside />}
      bleed={handle.bleed}
      ground={handle.ground}
      backCloses={false}
    >
      {children}
    </Dialog>
  );
}

/** As long as the lightbox's picture takes to grow out of its tile. */
const FULLSCREEN_FADE = 'mrx-fade-in 380ms ease both';

/** Keys typed into these are the field's, Escape included. */
const typingIn = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function FullscreenFrame({ children }: { children: ReactNode }) {
  useSignals();
  const surface = useContext(SurfaceContext)!;
  // The drawer, lifted beside it (`fullscreenBesideDrawer`), is left its width, and stays a location
  // to scroll and type in: a shard of the scroll lock, and outside a focus trap that is not set.
  const beside = fullscreenBesideDrawer.value;
  // Escape closes it unless the route has taken the key itself (the lightbox closes a layer
  // over it first, and its hotkey prevents the default) or it is typed into a field. Mantine's
  // own handler would know neither, and would close the route under a layer. The page's hotkeys
  // listen where the route's do, so a page binds Escape without preventing it, or the key is lost
  // while the route is still loading.
  useWindowEvent('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !typingIn(event.target)) surface.close();
  });
  return (
    <Modal
      opened
      onClose={surface.close}
      closeOnEscape={false}
      fullScreen
      withCloseButton={false}
      padding={0}
      trapFocus={beside === null}
      removeScrollProps={beside === null ? undefined : { shards: [...document.querySelectorAll<HTMLElement>('.mrx-drawer-aside')] }}
      // It fades in by a keyframe animation rather than Mantine's transition, which only moves
      // between two styles the browser has painted: mounted open, the frame reaches the page
      // already in its entered style, and would appear at once. An animation runs from the first
      // frame the element is drawn. On the overlay and the inner box rather than the root, which
      // has no z-index of its own: faded, it would become a stacking context at the page's level
      // and slip under the header until done.
      transitionProps={{ duration: 0 }}
      styles={{
        overlay: { animation: FULLSCREEN_FADE },
        body: { padding: 0, height: '100%' },
        content: { background: 'var(--mrx-surface-base)' },
        inner: { padding: 0, animation: FULLSCREEN_FADE, ...(beside === null ? {} : { right: 'auto', width: `calc(100% - ${beside})` }) },
      }}
    >
      {children}
    </Modal>
  );
}

/**
 * The surface's frame around its route: the dialog's modal or the drawer's scrolling box. None for
 * a panel, which the page around it frames, nor for full screen, whose frame is around the router
 * (`SurfaceRouter`).
 */
function SurfaceFrame({ children, handle = {} }: { children: ReactNode; handle?: SurfaceHandle }) {
  const surface = useContext(SurfaceContext)!;
  if (surface.kind === 'dialog') return <DialogFrame handle={handle}>{children}</DialogFrame>;
  if (surface.kind === 'panel' || surface.kind === 'fullscreen') return <>{children}</>;
  return <Box h='100%' style={{ overflow: 'auto' }}>{children}</Box>;
}

function SurfaceRoot() {
  return (
    <SurfaceFrame handle={useHandle()}>
      <Outlet />
    </SurfaceFrame>
  );
}

/** What a panel draws in place of its route while it loads, and if it fails: a page's own by default. */
type PanelPlaceholders = { loading?: ReactNode; failed?: ReactNode };

const PlaceholderContext = createContext<PanelPlaceholders>({});

function SurfaceLoading() {
  const { loading } = useContext(PlaceholderContext);
  return (
    <SurfaceFrame>
      {loading === undefined ? <PageLoader /> : loading}
    </SurfaceFrame>
  );
}

function SurfaceError() {
  const { failed } = useContext(PlaceholderContext);
  return (
    <SurfaceFrame>
      {failed === undefined ? <RouteError /> : failed}
    </SurfaceFrame>
  );
}

/** The shell's page for a path nothing matches, or a panel's `failed` in its place: no route is a route that failed. */
function SurfaceMissing({ children }: { children: ReactNode }) {
  const { failed } = useContext(PlaceholderContext);
  return <>{failed === undefined ? children : failed}</>;
}

/** The shell's routes for a surface's router, its catch-all drawing `SurfaceMissing`. */
const surfaceChildRoutes = (): RouteObject[] =>
  shellChildRoutes().map((route) => (route.path === '*' ? { ...route, element: <SurfaceMissing>{route.element}</SurfaceMissing> } : route));

/**
 * A router's provider, and the router started once the provider listens. `RouterProvider` takes
 * the router's state when it renders and subscribes to it when it commits, and a router started
 * before that can finish in between — a page drawn in a transition yields there — which leaves the
 * provider on its loading fallback for good.
 */
function StartedRouter({ router }: { router: DataRouter }) {
  // After the provider's own layout effect, where it subscribes: children's run first.
  useLayoutEffect(() => {
    router.initialize();
  }, [router]);
  return <RouterProvider router={router} />;
}

/**
 * A route rendered in the shell's dialog, drawer or full-screen surface, by a router of its own
 * over the shell's route table — module routes patched in as for the page — so a route need
 * not know where it is shown. A navigation inside that leaves the surface opens on the page
 * instead: in the dialog any navigation (the dialog closes; a form that made something opens
 * it), in the drawer, full screen and a panel one outside the route's first segment (the chat moving
 * between its conversations, the lightbox between pictures, stay). Full screen, a navigation
 * that stays is written into the page's URL, where that surface lives, and one that leaves
 * takes its place in history. Rendered inside the page's router, so the page's location and
 * route context are hidden from this one, which would otherwise refuse to nest and resolve
 * against them.
 *
 * `path` may change under a surface that stays open (Back and Forward between two pictures):
 * the router follows it rather than being made again.
 */
export function SurfaceRouter({ kind, path, onClose, placeholders = NO_PLACEHOLDERS }: {
  kind: Exclude<SurfaceKind, 'page'>;
  path: string;
  onClose: () => void;
  placeholders?: PanelPlaceholders;
}) {
  const firstPath = useRef(path);
  // `createMemoryRouter`'s router, not yet started: `StartedRouter` starts it.
  const router = useMemo(() => {
    const routes: RouteObject[] = [
      { id: 'root', path: '/', ...awaitModuleRoutes, Component: SurfaceRoot, HydrateFallback: SurfaceLoading, ErrorBoundary: SurfaceError, children: surfaceChildRoutes() },
    ];
    return UNSAFE_createRouter({
      history: UNSAFE_createMemoryHistory({ initialEntries: [firstPath.current] }),
      routes,
      mapRouteProperties: UNSAFE_mapRouteProperties,
      hydrationRouteProperties: UNSAFE_hydrationRouteProperties,
      patchRoutesOnNavigation: modulePatcher(),
    });
  }, []);
  useEffect(() => () => router.dispose(), [router]);

  useEffect(() => {
    const here = router.state.location;
    if (`${here.pathname}${here.search}${here.hash}` !== path) void router.navigate(path, { replace: true });
  }, [path, router]);

  useEffect(() => {
    const base = routeBase(firstPath.current);
    const start = firstPath.current.split(/[?#]/)[0];
    return router.subscribe((state) => {
      const target = state.navigation.location ?? state.location;
      const to = `${target.pathname}${target.search}${target.hash}`;
      if (kind === 'dialog' ? target.pathname === start : underBase(target.pathname, base)) {
        if (kind === 'fullscreen' && !state.navigation.location && to !== fullscreenPath.peek()) openFullscreen(to);
        return;
      }
      if (kind === 'fullscreen') {
        leaveFullscreen(to);
        return;
      }
      navigatePage(to);
      if (kind === 'dialog') {
        onClose();
      } else if (state.navigation.location) {
        // Still on its way: stay where the drawer was instead.
        void router.navigate(`${state.location.pathname}${state.location.search}`, { replace: true });
      } else {
        void router.navigate(-1);
      }
    });
  }, [router]);

  const surface = useMemo<Surface>(() => ({
    kind,
    close: onClose,
    openPage: (to) => {
      if (kind === 'fullscreen') return leaveFullscreen(to);
      navigatePage(to);
      if (kind === 'dialog') onClose();
    },
  }), [kind, onClose]);

  const routed = (
    <UNSAFE_LocationContext.Provider value={null as never}>
      <UNSAFE_RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>
        <StartedRouter router={router} />
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_LocationContext.Provider>
  );
  // A new router always draws its loading fallback first, and the route replaces it. Full screen,
  // one frame holds both, so its fade runs once from the first frame rather than starting over
  // when the route arrives, which showed as the page dimming, brightening and dimming again.
  return (
    <SurfaceContext.Provider value={surface}>
      <PlaceholderContext.Provider value={placeholders}>
        {kind === 'fullscreen' ? <FullscreenFrame>{routed}</FullscreenFrame> : routed}
      </PlaceholderContext.Provider>
    </SurfaceContext.Provider>
  );
}

const NO_PLACEHOLDERS: PanelPlaceholders = {};

const stayOpen = () => {};

/**
 * A module's route drawn inside another page: where a `panels` navigation entry puts it, or where
 * an answer names it (a feed entry's `route`). The page and the module do not name each other. A
 * navigation that leaves the route opens on the page, as from the drawer; there is nothing to
 * close. `loading` and `failed` stand in for the route while it loads and if it fails, where the
 * page's own loader and error would not fit (an entry in a list); absent, those are drawn.
 */
export function RoutePanel({ path, loading, failed }: { path: string; loading?: ReactNode; failed?: ReactNode }) {
  return <SurfaceRouter kind='panel' path={path} onClose={stayOpen} placeholders={{ loading, failed }} />;
}
