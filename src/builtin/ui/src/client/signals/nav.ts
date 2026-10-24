import { signal } from '@preact/signals-react';
import type { NavAction, PanelEntry, UiNav } from '@ui/nav';
import { execCommand } from './shell-client.ts';
import { preloadIcons } from '../lib/tabler-icons.ts';
import { lightboxRoute } from '../lib/lightbox-route.ts';
import { loadUiManifest, prefetchRoute } from './module-ui.ts';
import { openDialog, openFullscreen, toggleDrawer } from './surface.ts';
export type { NavAction, NavLink, PanelEntry, ResolvedSection, ResolvedTopbarEntry, UiNav } from '@ui/nav';

/**
 * The sidebar and top bar, as `ui-nav` resolves them for this person: every module's
 * entries with the administrator's and their own changes laid over (src/builtin/ui/lib/nav.ts).
 *
 * Loaded with the auth check, before anything is drawn, so the shell never shows an empty
 * sidebar that fills in.
 */
export const uiNav = signal<UiNav>({ sections: [], topbar: [], panels: [], warnings: [] });

export async function loadNav(): Promise<void> {
  try {
    // The module manifest too, waited for with the navigation: it says which page opens which
    // node (`openRoute`), which a link drawn from the first page already needs.
    const [nav] = await Promise.all([execCommand<UiNav>('ui-nav'), loadUiManifest()]);
    for (const warning of nav.warnings) console.warn(`ui-nav: ${warning}`);
    // Before the shell is drawn, so the page's own downloads (a grid's covers) cannot queue in
    // front of them: the icons (waited for), and the bundles of the module routes the top bar
    // opens in a dialog, the drawer or full screen (not waited for). After a first visit they
    // come from the cache.
    for (const entry of nav.topbar.flatMap((entry) => [entry, ...(entry.menu ?? [])])) {
      const route = entry.action && surfaceRoute(entry.action);
      if (route) void prefetchRoute(route);
    }
    // So is the lightbox (media's), which any grid opens full screen.
    void prefetchRoute(lightboxRoute('/'));
    await preloadIcons([
      ...nav.sections.flatMap((section) => section.items.map((item) => item.icon)),
      ...nav.topbar.flatMap((entry) => [entry.icon, ...(entry.menu ?? []).map((row) => row.icon)]),
      ...nav.panels.flatMap((panel) => panel.icon ?? []),
    ]);
    uiNav.value = nav;
  } catch (error) {
    // No navigation is a broken-looking shell, but every page still works by its URL.
    console.error('ui-nav failed', error);
  }
}

/** The panels a page shows at `slot` (`nodes.tools`, `system.tabs`, `stats.sections`, `search.explore`, …), in order. */
export const panelsOf = (slot: string): PanelEntry[] => uiNav.value.panels.filter((panel) => panel.slot === slot);

/** A panel's route, `{path}` filled with the node path the slot is about. */
export const panelRoute = (panel: PanelEntry, path = ''): string => panel.route.replaceAll('{path}', encodeURIComponent(path));

/** What an action can use of the app it runs in. */
export type ActionContext = { navigate: (to: string) => void };

/** `{key}` in a route, filled from a command's JSON answer. */
const fillRoute = (route: string, answer: unknown): string =>
  route.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = answer && typeof answer === 'object' ? (answer as Record<string, unknown>)[key] : undefined;
    return encodeURIComponent(value === undefined || value === null ? '' : String(value));
  });

/** The route an entry opens in a surface over or beside the page. */
const surfaceRoute = (action: NavAction): string | undefined =>
  'dialog' in action ? action.dialog : 'drawer' in action ? action.drawer : 'fullscreen' in action ? action.fullscreen : undefined;

/** Do what a navigation entry says. Resolves when it is done, so a button can show it working. */
export async function runNavAction(action: NavAction, ctx: ActionContext): Promise<void> {
  if ('dialog' in action) {
    openDialog(action.dialog);
    return;
  }
  if ('drawer' in action) {
    toggleDrawer(action.drawer);
    return;
  }
  if ('fullscreen' in action) {
    openFullscreen(action.fullscreen);
    return;
  }
  if ('run' in action) {
    const answer = await execCommand<unknown>(action.run);
    if (action.navigate) ctx.navigate(fillRoute(action.navigate, answer));
    return;
  }
  ctx.navigate(action.navigate);
}
