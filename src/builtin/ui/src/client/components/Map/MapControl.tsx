import { type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';
import { MapControlsContext } from './context.ts';

/**
 * Above the map, and nowhere near Leaflet's own 1000.
 *
 * Anything floated over a map sits outside `.leaflet-container`, so it is not covered by the
 * isolation that keeps Leaflet's stacking to itself: a big number would escape upwards and paint
 * over the lightbox. The whole map is one flat layer in the page, so beating it takes 1, and
 * anything overlaying the page still wins.
 */
export const MAP_CONTROL_Z = 1;

/**
 * Something of a layer's or a page's own among the map's controls: in the column of buttons in its
 * top-right corner, under the map's own, or in its top-left corner. Drawn wherever it is given
 * inside the map; nothing until the map has its corners.
 */
export function MapControl({ place = 'top-right', children }: { place?: 'top-right' | 'top-left'; children: ReactNode }) {
  const target = useContext(MapControlsContext)[place];
  return target ? createPortal(children, target) : null;
}
