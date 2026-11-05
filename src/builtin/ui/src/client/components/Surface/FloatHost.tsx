import { useSignals } from '@preact/signals-react/runtime';
import { panelRoute, panelsOf } from '../../signals/nav.ts';
import { FLOAT_LAYER } from './float-layer.ts';
import { RoutePanel } from './SurfaceRouter.tsx';

/**
 * The `shell.float` panels: what a module floats over every page — a button that stays where it is
 * put — drawn once for the whole app, above the page, the drawer and the full-screen lightbox and
 * under a dialog. The layer has no size of its own: a panel places what it draws itself, `position:
 * fixed`, and the page under it stays to be pointed at. Nothing stands in for a panel while it loads
 * or if it fails.
 */
export function FloatHost() {
  useSignals();
  const panels = panelsOf('shell.float');
  return (
    <div className={FLOAT_LAYER}>
      {panels.map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} loading={null} failed={null} />)}
    </div>
  );
}
