import { assertEquals } from '@std/assert';
import { createMemoryRouter } from 'react-router-dom';
import { registerShellRouting } from '../../signals/module-ui.ts';
import { closeFullscreen, openFullscreen } from '../../signals/surface.ts';

/** The page's router over a grid, handed to the shell as the entry does. */
const pageAt = (entry: string) => {
  const router = createMemoryRouter([{ id: 'root', path: '*' }], { initialEntries: [entry] });
  router.initialize();
  registerShellRouting([], router);
  return router;
};

const here = (router: ReturnType<typeof createMemoryRouter>) => `${router.state.location.pathname}${router.state.location.search}`;

/** Until the router has come back from a step through history. */
const settled = (router: ReturnType<typeof createMemoryRouter>) =>
  new Promise<void>((resolve) => {
    const stop = router.subscribe((state) => {
      if (state.navigation.state !== 'idle') return;
      stop();
      resolve();
    });
  });

Deno.test('full screen: another route shown in its place is not an entry, a step is', async () => {
  const router = pageAt('/albums/x');
  try {
    openFullscreen('/media/a');
    openFullscreen('/media/b');
    assertEquals(here(router), '/albums/x?fullscreen=%2Fmedia%2Fb');

    // A step from b: Back returns to b, still full screen.
    openFullscreen('/media/s', { step: true });
    assertEquals(here(router), '/albums/x?fullscreen=%2Fmedia%2Fs');
    let back = settled(router);
    void router.navigate(-1);
    await back;
    assertEquals(here(router), '/albums/x?fullscreen=%2Fmedia%2Fb');

    // Two steps, then close: back past both to the page it opened over.
    openFullscreen('/media/s', { step: true });
    openFullscreen('/media/t', { step: true });
    back = settled(router);
    closeFullscreen();
    await back;
    assertEquals(here(router), '/albums/x');
  } finally {
    router.dispose();
  }
});

Deno.test('full screen opened by a link has no entry to step from: a step replaces it', () => {
  const router = pageAt('/albums/x?fullscreen=%2Fmedia%2Fa');
  try {
    openFullscreen('/media/s', { step: true });
    assertEquals(here(router), '/albums/x?fullscreen=%2Fmedia%2Fs');
    closeFullscreen();
    assertEquals(here(router), '/albums/x');
  } finally {
    router.dispose();
  }
});
