// @ts-types="@types/leaflet"
import type { Map as LeafletMap } from 'leaflet';
import { createContext, useContext, useEffect, useState } from 'react';
import type { GeoBounds } from './types.ts';

/** The leaflet map instance, provided by MapView to its layer children. */
export const MapContext = createContext<LeafletMap | null>(null);

/** Current map instance, or null while MapView is still mounting. */
export function useMap(): LeafletMap | null {
  return useContext(MapContext);
}

/** Where a map looks: the box it shows and its zoom. */
export type MapViewport = { bounds: GeoBounds; zoom: number };

/** Where the map around it looks, again after each move; null while the map is mounting. */
export function useMapViewport(): MapViewport | null {
  const map = useMap();
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  useEffect(() => {
    if (!map) return;
    const report = () => {
      const box = map.getBounds();
      setViewport({ bounds: { north: box.getNorth(), south: box.getSouth(), east: box.getEast(), west: box.getWest() }, zoom: map.getZoom() });
    };
    report();
    map.on('moveend', report);
    return () => {
      map.off('moveend', report);
    };
  }, [map]);
  return viewport;
}

/**
 * What one layer tells its map: that it is reading, the box what it shows lies in, and a line for
 * its switch in the layer picker. A map's own children report as a layer without an id.
 */
export type MapLayerReport = {
  busy: (busy: boolean) => void;
  extent: (bounds: GeoBounds | undefined) => void;
  note: (note: string | undefined) => void;
};

const QUIET: MapLayerReport = { busy: () => {}, extent: () => {}, note: () => {} };

/** The layer a part is drawn in, given by MapView around each layer and around its own children. */
export const MapLayerContext = createContext<MapLayerReport>(QUIET);

/** Show the map's loading mark while `busy`: the layer around it is reading what it draws. */
export function useMapBusy(busy: boolean): void {
  const report = useContext(MapLayerContext);
  useEffect(() => {
    report.busy(busy);
  }, [report, busy]);
  useEffect(() => () => report.busy(false), [report]);
}

/**
 * The box what the layer around it shows lies in, which a map told to `fit` its layers moves to
 * when it has no place of its own; undefined while it has none.
 */
export function useMapExtent(bounds: GeoBounds | undefined): void {
  const report = useContext(MapLayerContext);
  useEffect(() => {
    report.extent(bounds);
  }, [report, bounds?.north, bounds?.south, bounds?.east, bounds?.west]);
  useEffect(() => () => report.extent(undefined), [report]);
}

/** A line under the layer's switch in the layer picker, such as why it draws nothing now; none when undefined. */
export function useMapLayerNote(note: string | undefined): void {
  const report = useContext(MapLayerContext);
  useEffect(() => {
    report.note(note);
  }, [report, note]);
  useEffect(() => () => report.note(undefined), [report]);
}

/** Where a map's controls go: the column in its top-right corner and its top-left corner. */
export type MapControlPlaces = { 'top-right': HTMLElement | null; 'top-left': HTMLElement | null };

export const MapControlsContext = createContext<MapControlPlaces>({ 'top-right': null, 'top-left': null });

/** Whether the map around it is one enlarged over the page by its full-screen button. */
export const MapEnlargedContext = createContext(false);

/** Whether the map around it is enlarged over the page: a part may draw more there than on the small map. */
export function useMapEnlarged(): boolean {
  return useContext(MapEnlargedContext);
}
