/**
 * MapView — thin React wrapper owning a leaflet map instance. Layer children
 * (MapShape, MapTracks, MapMarkers, MapShapeEditor) get the map via context.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
// Vendored copy of leaflet/dist/leaflet.css with the PNG icon urls replaced
// by inline SVG (deno bundle has no image loader)
import './leaflet.css';
import { MapContext } from './context.ts';
import { BASE_LAYERS } from './layers.ts';
import type { GeoBounds, PositionPoint } from './types.ts';

export const DEFAULT_CENTER: PositionPoint = { lat: 57.7, lng: 11.97 };
export const DEFAULT_ZOOM = 12;

export type MapViewProps = {
  /**
   * Where to put the camera. Re-applied whenever it changes, which makes it a
   * command rather than a description — so never feed it geometry the user is
   * editing. A polygon reports its centroid as its point, and passing that back
   * here would yank the map (and reset `zoom`) on every vertex touched.
   */
  center?: PositionPoint;
  zoom?: number;
  /** Fit the view to these bounds (overrides center/zoom while set). */
  bounds?: GeoBounds;
  onClick?: (point: PositionPoint) => void;
  onMoveEnd?: (bounds: GeoBounds, zoom: number) => void;
  /**
   * Which base layer to show, by its name in `layers.ts`. A change swaps it in;
   * a pick in Leaflet's switcher is reported through `onBaseLayerChange`, and a
   * page that feeds it back finds that layer already showing.
   */
  baseLayer?: string;
  onBaseLayerChange?: (name: string) => void;
  /** Leaflet's own base-layer switcher, for a page that does not offer the choice itself. */
  layerSwitcher?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
};

function toGeoBounds(b: L.LatLngBounds): GeoBounds {
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

export function MapView({ center, zoom, bounds, onClick, onMoveEnd, baseLayer, onBaseLayerChange, layerSwitcher = true, style, children }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const initialBaseLayer = useRef(baseLayer);
  const initialLayerSwitcher = useRef(layerSwitcher);
  /** The base layers by name, and the one on the map. */
  const baseLayersRef = useRef<{ layers: Record<string, L.Layer>; current: string }>({ layers: {}, current: '' });
  const baseLayerChanged = useRef(onBaseLayerChange);
  baseLayerChanged.current = onBaseLayerChange;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const m = L.map(el, {
      center: center ?? DEFAULT_CENTER,
      zoom: zoom ?? DEFAULT_ZOOM,
      // Wheel and pinch zoom; buttons would only cover the map.
      zoomControl: false,
    });

    const baseLayers: Record<string, L.Layer> = {};
    const wanted = BASE_LAYERS.find((def) => def.name === initialBaseLayer.current) ?? BASE_LAYERS[0];
    BASE_LAYERS.forEach((def) => {
      const layer = L.layerGroup(def.tiles.map((tile) => L.tileLayer(tile.url, tile.options)));
      baseLayers[def.name] = layer;
      if (def === wanted) layer.addTo(m);
    });
    baseLayersRef.current = { layers: baseLayers, current: wanted.name };
    if (BASE_LAYERS.length > 1 && initialLayerSwitcher.current) {
      L.control.layers(baseLayers).addTo(m);
    }
    m.on('baselayerchange', (event: L.LayersControlEvent) => {
      baseLayersRef.current.current = event.name;
      baseLayerChanged.current?.(event.name);
    });

    // Tracks render a black casing under the colored line; own pane keeps
    // casings from covering other tracks' colors
    m.createPane('casing');
    m.getPane('casing')!.style.zIndex = '399';

    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(el);

    setMap(m);

    return () => {
      observer.disconnect();
      m.remove();
      // Leaflet 1.9 ends a zoom animation from a bare 250 ms timeout that
      // `remove()` does not cancel, and the late callback then reads the
      // removed panes (`_leaflet_pos` of undefined), as a map unmounted mid-zoom
      // does — a tab switched while a shape is still being fitted. The callback
      // returns early when no zoom is animating.
      (m as unknown as { _animatingZoom: boolean })._animatingZoom = false;
      setMap(null);
    };
  }, []);

  useEffect(() => {
    const base = baseLayersRef.current;
    const next = BASE_LAYERS.find((def) => def.name === baseLayer) ?? BASE_LAYERS[0];
    if (!map || next.name === base.current) return;
    map.removeLayer(base.layers[base.current]);
    base.layers[next.name].addTo(map);
    base.current = next.name;
  }, [map, baseLayer]);

  useEffect(() => {
    if (!map || bounds) return;
    map.setView(center ?? DEFAULT_CENTER, zoom ?? map.getZoom());
  }, [map, center?.lat, center?.lng, zoom]);

  useEffect(() => {
    if (!map || !bounds) return;
    map.fitBounds(L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]), { padding: [20, 20] });
  }, [map, bounds?.north, bounds?.south, bounds?.east, bounds?.west]);

  useEffect(() => {
    if (!map || !onClick) return;
    const handler = (e: L.LeafletMouseEvent) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onClick]);

  useEffect(() => {
    if (!map || !onMoveEnd) return;
    const handler = () => onMoveEnd(toGeoBounds(map.getBounds()), map.getZoom());
    map.on('moveend', handler);
    // Report the initial viewport so pages can load data before any pan
    handler();
    return () => {
      map.off('moveend', handler);
    };
  }, [map, onMoveEnd]);

  return (
    <div ref={containerRef} style={{ height: '100%', minHeight: 200, ...style }}>
      <MapContext.Provider value={map}>{map ? children : null}</MapContext.Provider>
    </div>
  );
}
