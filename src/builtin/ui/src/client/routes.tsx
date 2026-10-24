import { CommandReference, EnvironmentReference, ModulesReference, NodeTypeReference, SettingsReference } from '@ein/ui/components';
import { Outlet, type RouteObject } from 'react-router-dom';
import { NotFound, RouteError } from './components/RouteProblem/RouteProblem.tsx';
import Layout from './Layout.tsx';
import DocsLayout, { DocPage, DocsIndexPage, ModulePage } from './pages/docs.tsx';
import HomePage from './pages/home.tsx';
import LoginPage from './pages/login.tsx';
import NodesPage from './pages/nodes.tsx';
import InstanceDetailPage from './pages/pipeline-instance.tsx';
import PipelineDetailPage from './pages/pipeline.tsx';
import ProfilePage from './pages/profile.tsx';
import SearchPage from './pages/search.tsx';
import SettingsPage from './pages/settings.tsx';
import SharedLinkPage from './pages/shared-link.tsx';
import StatsPage from './pages/stats.tsx';
import SystemPage from './pages/system.tsx';
import TrashPage from './pages/trash.tsx';
import { awaitModuleRoutes } from './signals/module-ui.ts';
import AboutPage, { ABOUT_WIDTH, AboutHero } from './pages/about.tsx';

/** Drawn edge to edge: the frame leaves out its padding (`Layout`), as for a module page saying the same. */
const fullBleed = { fullBleed: true };
/** The reader's own: the guest is sent to sign in for it (`Layout`). */
const ownPage = { fullBleed: true, signedIn: true };

/**
 * The shell's routes. A module's are not here: the router adds them from the manifest `ui-build`
 * writes when a path matches none of these (`signals/module-ui.ts`), and the dialog, drawer and
 * full-screen surfaces render from this same table.
 *
 * A path nothing matches lands on the `*` child. The router still asks for module routes first: a
 * splat's match has a parameter, which it takes as a sign that a more particular route may yet be
 * found. What fails to load or draw ends on the root's error page, inside the frame as well.
 */
export const routes: RouteObject[] = [{
  id: 'root',
  path: '/',
  ...awaitModuleRoutes,
  element: (
    <Layout>
      <Outlet />
    </Layout>
  ),
  ErrorBoundary: () => (
    <Layout>
      <RouteError />
    </Layout>
  ),
  children: [
    { index: true, element: <HomePage />, handle: fullBleed },
    { path: 'login', element: <LoginPage /> },
    // Where a share link lands; drawn outside the frame, like the sign-in page (`Layout`).
    { path: 's/:token', element: <SharedLinkPage /> },
    {
      path: 'docs',
      // The docs section draws its own header and gutters on every page under it.
      handle: fullBleed,
      element: (
        <DocsLayout>
          <Outlet />
        </DocsLayout>
      ),
      children: [
        { index: true, element: <DocsIndexPage /> },
        { path: ':id', element: <DocPage /> },
        { path: 'commands', element: <CommandReference /> },
        { path: 'environment', element: <EnvironmentReference /> },
        { path: 'modules', element: <ModulesReference /> },
        { path: 'modules/:name', element: <ModulePage /> },
        { path: 'node-types', element: <NodeTypeReference /> },
        { path: 'settings', element: <SettingsReference /> },
      ],
    },
    // Opened in the dialog from the account menu; it draws its own header there.
    { path: 'about', element: <AboutPage />, handle: { title: 'About EiN', hero: AboutHero, ground: 'base', signedIn: true, dialogSize: ABOUT_WIDTH } },
    { path: 'profile', element: <ProfilePage />, handle: ownPage },
    { path: 'search', element: <SearchPage />, handle: fullBleed },
    { path: 'settings', element: <SettingsPage />, handle: ownPage },
    { path: 'stats', element: <StatsPage />, handle: fullBleed },
    { path: 'trash', element: <TrashPage />, handle: ownPage },
    { path: 'system', element: <SystemPage />, handle: fullBleed },
    { path: 'system/nodes', element: <NodesPage />, handle: fullBleed },
    // A pipeline's page wears the system header; the instance page under it does not.
    { path: 'system/pipelines/:pipeline', element: <PipelineDetailPage />, handle: fullBleed },
    { path: 'system/pipelines/:pipeline/:id', element: <InstanceDetailPage /> },
    { path: '*', element: <NotFound />, handle: fullBleed },
  ],
}];
