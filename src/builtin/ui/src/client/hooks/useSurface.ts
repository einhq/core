import type { SurfaceKind } from '@ein/ui/signals';
import { createContext, useContext } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Where a route is shown, and what it may do about it: a route is a page, or open in the
 * shell's dialog, drawer or full-screen surface, and does not otherwise know which
 * (`signals/surface.ts`).
 */
export type Surface = {
  kind: SurfaceKind;
  /** Close the dialog, drawer or full-screen surface; on a page, go back. */
  close: () => void;
  /**
   * Open a location as the page — and close the dialog — as when a form has made something.
   * From full screen it takes the surface's location in history.
   */
  openPage: (to: string) => void;
};

/** Set by the dialog, the drawer and the full-screen surface around their router; absent on the page. */
export const SurfaceContext = createContext<Surface | null>(null);

export function useSurface(): Surface {
  const surface = useContext(SurfaceContext);
  const navigate = useNavigate();
  if (surface) return surface;
  return {
    kind: 'page',
    // A page opened by its URL has nothing to go back to in this app: home instead.
    close: () => (history.length > 1 ? navigate(-1) : navigate('/')),
    openPage: (to) => navigate(to),
  };
}
