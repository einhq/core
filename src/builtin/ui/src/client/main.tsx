/**
 * The shell's entry, which `index.html` loads: the stylesheets, the runtime module bundles read
 * (`lend.ts`, before any of them can load), and the page's router over `routes.tsx`.
 */
import '@mantine/core/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/charts/styles.css';
import '@xterm/xterm/css/xterm.css';
import './lend.ts';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { crossfadePages } from './lib/page-crossfade.ts';
import { routes } from './routes.tsx';
import { modulePatcher, registerShellRouting } from './signals/module-ui.ts';

const router = createBrowserRouter(routes, {
  // A path none of the shell's routes match may be a module's: its routes are added
  // under the root then, from the manifest ui-build writes (signals/module-ui.ts).
  patchRoutesOnNavigation: modulePatcher(),
});

crossfadePages(router);

// The dialog, the drawer and the full-screen surface render routes from the same table, and hand
// the page what leaves them.
registerShellRouting(routes, router);

addEventListener('DOMContentLoaded', () => {
  createRoot(document.getElementById('app')!).render(<RouterProvider router={router} />);
});
