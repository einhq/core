import { type DataRouter, NavigationType, type RouterSubscriber } from 'react-router-dom';

/**
 * Cross-fade the page when a navigation lands on another path. `RouterProvider` runs an update
 * as a view transition (`document.startViewTransition`) when its subscriber is handed
 * `viewTransitionOpts`; this hands them over for every such step, whichever link, button or
 * Back took it, so no navigation has to ask. The fade itself is `::view-transition-*(root)` in
 * theme.css.
 *
 * Only a push or a step through history is another page. A replace keeps the reader where they
 * are — a redirect, or a URL following what the page shows, such as the lightbox's picture as you
 * arrow through — and a change of search or hash alone is a filter, a tab or the full-screen
 * route; all of these swap in place.
 */
export const crossfadePages = (router: DataRouter): void => {
  const subscribe = router.subscribe.bind(router);
  router.subscribe = (subscriber: RouterSubscriber) => {
    let shown = router.state.location;
    return subscribe((state, opts) => {
      const from = shown;
      shown = state.location;
      const turn = !opts.viewTransitionOpts && state.historyAction !== NavigationType.Replace && state.location.pathname !== from.pathname;
      subscriber(state, turn ? { ...opts, viewTransitionOpts: { currentLocation: from, nextLocation: state.location } } : opts);
    });
  };
};
