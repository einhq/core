// @ts-types="@types/leaflet"
import type { Map as LeafletMap } from 'leaflet';
import { createContext, useContext } from 'react';

/** The leaflet map instance, provided by MapView to its layer children. */
export const MapContext = createContext<LeafletMap | null>(null);

/** Current map instance, or null while MapView is still mounting. */
export function useMap(): LeafletMap | null {
  return useContext(MapContext);
}
