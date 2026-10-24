import { AppShell, Box, MantineProvider } from '@mantine/core';
import { useDisclosure, useDocumentTitle, useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { AppHeader, AppNavbar, CodeEditorModal, DialogHost, DrawerHost, FullscreenHost, ShareModalHost, Terminal } from '@ein/ui/components';
import { CommandPalette } from './components/Palette/CommandPalette.tsx';
import { ToastHost } from './components/Toast/ToastHost.tsx';
import { BackToTop } from './components/Layout/BackToTop.tsx';
import { PageScrollbar } from './components/Layout/PageScrollbar.tsx';
import { ShortcutHelp } from './components/Palette/ShortcutHelp.tsx';
import { watchSidebarSwipe } from './lib/sidebar-swipe.ts';
import {
  checkAuth,
  DRAWER_BESIDE_QUERY,
  drawerPath,
  drawerWidth,
  fullscreenBesideDrawer,
  fullscreenPath,
  guestBrowsing,
  heldLinkRoutes,
  heldLinks,
  initShellClient,
  isAuthenticated,
  linkVisitor,
  loadNav,
  loadUiManifest,
  loadUserConfig,
  mobileRailHidden,
  mobileSidebarRail,
  nodeRoutes,
  routeBase,
  shellClientConnected,
  sidebarCollapsed,
  toggleMobileRailHidden,
  toggleSidebar,
  uiNav,
  underBase,
} from '@ein/ui/signals';
import { pageTitle } from './signals/page-subject.ts';
import { HEADER_HEIGHT, PHONE_HEADER_HEIGHT, usePhone } from '@ein/ui/hooks';
import { loginReturnPath, loginUrlFor } from '@ein/ui/lib';
import { isShareLinkPage, withinRoute } from './lib/share-link.ts';
import { cssVariablesResolver, theme } from '@ein/ui/theme';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useMatches, useNavigate } from 'react-router-dom';
import './theme/theme.css';

/** The icon rail's width. */
const RAIL_WIDTH = 72;
/** How long the side drawer and the rail take to slide (`AppShell`'s `transitionDuration`). */
const DRAWER_SLIDE_MS = 280;

type Props = {
  children: ReactNode;
};

export default function Layout({ children }: Props) {
  useSignals();
  const [opened, { toggle, open, close }] = useDisclosure();
  const mobile = usePhone();
  const rail = mobile ? mobileSidebarRail.value : sidebarCollapsed.value;
  // On a phone the rail is not a menu to open: while shown it stays beside the
  // page and takes its width, as it does on a desktop. Only the labelled list,
  // too wide to sit beside anything, opens over the page. The header's mark is
  // the phone's switch for either: it shows and hides the rail, or opens and
  // closes the list. A sideways swipe does the same (below).
  const mobileRail = mobile && rail;
  const menuOpen = mobileRail ? !mobileRailHidden.value : opened;
  const toggleMenu = mobileRail ? toggleMobileRailHidden : toggle;
  const [authChecked, setAuthChecked] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useDocumentTitle(pageTitle(location.pathname, uiNav.value.sections));

  const matches = useMatches();
  const isLoginPage = location.pathname === '/login';
  // Where a share link lands: open to anyone, drawn outside the frame like the sign-in page.
  const isLinkPage = isShareLinkPage(location.pathname);
  // A page says what it is on its route, the shell's (routes.tsx) or a module's, in its `handle`:
  // `fullBleed: true`, drawn edge to edge — any other page gets the `md` gutter (`.mrx-page`) —
  // and `signedIn: true`, a page of the reader's own or one that only writes, which the guest is
  // sent to sign in for.
  const handles = matches.map((match) => (match.handle ?? {}) as { fullBleed?: boolean; signedIn?: boolean });
  const isFullBleedPage = handles.some((handle) => handle.fullBleed === true);
  const isSignedInPage = handles.some((handle) => handle.signedIn === true);
  const authenticated = isAuthenticated.value;
  // Who the page is drawn for: someone signed in, the guest where the archive is open to it, or a
  // visitor holding a share link.
  const browsing = authenticated || guestBrowsing.value || heldLinks.value.length > 0;
  // A visitor held to their link sees the pages of what it opens, and none of the frame that leads
  // elsewhere: no sidebar.
  const confined = linkVisitor.value;
  const withinLink = !authenticated && heldLinkRoutes.value.some((link) => withinRoute(location.pathname, link.route));
  const connected = shellClientConnected.value;
  // The side drawer steps aside on its route's own page (the chat's), which is the same
  // route at full size; it is left open, so leaving the page brings it back.
  const drawerShown = drawerPath.value !== null && !underBase(location.pathname, routeBase(drawerPath.value));
  const desktopDrawerWidth = `min(${drawerWidth.value}px, calc(100vw - var(--app-shell-navbar-offset, 0rem) - 320px))`;
  // Over a route shown full screen the drawer rises above it to the window's height, beside it
  // rather than under it, so the chat stays in view with the lightbox (`fullscreenBesideDrawer`).
  // Not below `md`, where the drawer is the whole width and full screen covers it.
  const wide = useMediaQuery(DRAWER_BESIDE_QUERY, false, { getInitialValueInEffect: false });
  const besideFullscreen = drawerShown && wide && fullscreenPath.value !== null;
  const besideWidth = `min(${drawerWidth.value}px, calc(100vw - 320px))`;
  // The page makes room for the drawer once it is in, and takes the room back the moment it starts
  // out: the drawer slides over the page on the compositor, and the page lays out once each way
  // rather than on every frame of the slide, which on a grid of pictures is what makes it judder.
  const [drawerRoom, setDrawerRoom] = useState(drawerShown);
  useEffect(() => {
    if (!drawerShown) return setDrawerRoom(false);
    const timer = globalThis.setTimeout(() => setDrawerRoom(true), DRAWER_SLIDE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [drawerShown]);
  useLayoutEffect(() => {
    fullscreenBesideDrawer.value = besideFullscreen ? besideWidth : null;
  }, [besideFullscreen, besideWidth]);
  // Where the drawer covers the page, the page does not scroll beneath it (`.mrx-page-covered`): a
  // drag in the drawer that finds nothing there to scroll would move the page out of sight, and the
  // close, a step back in history, would show the browser scrolling it back.
  const pageCovered = drawerShown && !wide;
  useEffect(() => {
    if (!pageCovered) return;
    document.documentElement.classList.add('mrx-page-covered');
    return () => document.documentElement.classList.remove('mrx-page-covered');
  }, [pageCovered]);

  // On a phone a swipe to the right across the page or the sidebar brings the menu out, and one to
  // the left puts it away. Not under full screen, whose lightbox swipes between pictures, nor under
  // the drawer, which covers the page there.
  const shellRef = useRef<HTMLDivElement>(null);
  const swipeable = mobile && fullscreenPath.value === null && !drawerShown && !confined;
  useEffect(() => {
    if (!swipeable) return;
    return watchSidebarSwipe(() => shellRef.current, (swipe) => {
      if ((swipe === 'right') !== menuOpen) toggleMenu();
    });
  }, [swipeable, menuOpen, toggleMenu]);

  useEffect(() => {
    initShellClient();
  }, []);

  // Once the shell is connected: who is signed in, and their settings.
  useEffect(() => {
    if (connected && !authChecked) {
      checkAuth().then(loadUserConfig).finally(() => setAuthChecked(true));
    }
  }, [connected, authChecked]);

  // The navigation is the reader's, loaded once the auth check says who that is. Signing in
  // and out load the page again, so one reader's entries never reach the next. The shell
  // waits for it, so its sidebar never fills in under the reader; the login page does not.
  const [navLoaded, setNavLoaded] = useState(false);
  useEffect(() => {
    if (!browsing) {
      setNavLoaded(false);
      return;
    }
    if (!navLoaded) loadNav().finally(() => setNavLoaded(true));
  }, [browsing, navLoaded]);

  // Off to sign in: anyone not signed in, unless the archive is open to the guest, and then
  // still on a page that is only a signed-in reader's — or on a page a share link they hold opens.
  // The page asked for rides along as `next`, so signing in lands back on it; replacing the entry
  // keeps Back from returning to a page that only redirects again. Only the link itself leads to
  // what it opens: a visitor held to it who asks for any other page is asked to sign in for that.
  const mustSignIn = !authenticated && !isLinkPage && !withinLink && (!guestBrowsing.value || isSignedInPage);
  const routesKnown = Object.keys(nodeRoutes.value).length > 0;
  useEffect(() => {
    if (!authChecked || !mustSignIn || isLoginPage) return;
    // Which page shows a link's node comes with the modules' manifest, which may be on its way;
    // until it is in, the page may yet turn out to be under the link.
    if (confined && !routesKnown) return void loadUiManifest();
    navigate(loginUrlFor(location.pathname + location.search + location.hash), { replace: true });
  }, [authChecked, mustSignIn, isLoginPage, confined, routesKnown, navigate]);

  // Already signed in on the login page: go where the login would have gone.
  useEffect(() => {
    if (authChecked && authenticated && isLoginPage) {
      navigate(loginReturnPath(new URLSearchParams(location.search)), { replace: true });
    }
  }, [authChecked, authenticated, isLoginPage, navigate]);

  // Nothing is drawn until the auth check has answered: a visitor who must sign in
  // would otherwise see an empty shell flash before the redirect, and one who is
  // signed in would see the login form flash on /login. Past the check, each side
  // only draws for the visitor it is for, so the render before either redirect
  // stays blank too.
  const ready = authChecked && (isLoginPage ? !authenticated : isLinkPage || (!mustSignIn && navLoaded));

  // The login page renders without the AppShell but inside the same provider, so there is one
  // theme. forceColorScheme ignores a colour scheme stored in localStorage.
  return (
    <MantineProvider forceColorScheme='dark' theme={theme} cssVariablesResolver={cssVariablesResolver}>
      {!ready ? null : isLoginPage || isLinkPage ? children : (
        <>
          <AppShell
            ref={shellRef}
            header={{ height: mobile ? PHONE_HEADER_HEIGHT : HEADER_HEIGHT }}
            // Mantine turns the navbar full-width below its breakpoint; at 0 that
            // never happens, so the phone's rail keeps its width and the page is
            // offset by it, as on a desktop. Above a breakpoint of 0 is every
            // width, so hiding the rail is the `desktop` collapse.
            navbar={confined ? undefined : mobileRail ? { width: RAIL_WIDTH, breakpoint: 0, collapsed: { desktop: mobileRailHidden.value } } : {
              width: sidebarCollapsed.value ? RAIL_WIDTH : 240,
              breakpoint: 'sm',
              collapsed: { mobile: !opened },
            }}
            aside={{
              width: { base: '100%', md: besideFullscreen ? besideWidth : desktopDrawerWidth },
              breakpoint: 'md',
              collapsed: { mobile: !drawerShown, desktop: !drawerShown },
            }}
            transitionDuration={DRAWER_SLIDE_MS}
            styles={{
              // Chrome recedes: darker than the content it frames, separated by
              // depth rather than by a border.
              header: { backgroundColor: 'var(--mrx-surface-chrome)', borderBottom: 'none' },
              navbar: { backgroundColor: 'var(--mrx-surface-chrome)', borderRight: 'none' },
              // Without the drawer's room while it slides in (`drawerRoom`, above).
              main: { backgroundColor: 'var(--mrx-surface-base)', ...(drawerRoom ? {} : { paddingInlineEnd: 0 }) },
              aside: besideFullscreen ? { top: 0, height: '100dvh', zIndex: 'calc(var(--mantine-z-index-modal) + 1)' } : {},
            }}
          >
            <AppShell.Header>
              <AppHeader menuOpen={menuOpen} onToggleMenu={toggleMenu} />
            </AppShell.Header>

            {!confined && (
              <AppShell.Navbar className='mrx-shell-navbar'>
                <AppNavbar
                  rail={rail}
                  onNavigate={close}
                  onToggleRail={() => {
                    toggleSidebar(mobile);
                    // A phone's labelled list only shows while open, so asking for
                    // the labels opens it, and the rail that replaces it needs no menu.
                    if (mobile && rail) open();
                    else close();
                  }}
                />
              </AppShell.Navbar>
            )}

            {
              /* The gutter is the page's own, not AppShell's padding: AppShell slides its main's
                padding with the sidebar and the drawer, and would slide it between a page with a
                gutter and one without. The page's scrollbar comes before the aside, which covers it
                where the drawer covers the page. */
            }
            <AppShell.Main>
              <Box className='mrx-page' mod={{ gutter: !isFullBleedPage }}>
                {children}
              </Box>
              <PageScrollbar />
            </AppShell.Main>

            <AppShell.Aside className='mrx-drawer-aside' withBorder={false}>
              <DrawerHost />
            </AppShell.Aside>
          </AppShell>

          {/* The guest has no terminal: it may read the archive, not work in it. */}
          {authenticated && <Terminal />}
          <DialogHost />
          <FullscreenHost />
          <ShareModalHost />
          <CodeEditorModal />
          <BackToTop />
          <ToastHost />
          <CommandPalette />
          <ShortcutHelp />
        </>
      )}
    </MantineProvider>
  );
}
