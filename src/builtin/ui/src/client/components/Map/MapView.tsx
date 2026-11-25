/**
 * MapView — every map in EiN: a Leaflet map showing one style (the tiles under everything) and the
 * layers turned on over it, from core or any module, with the controls its page gives it: the style
 * and layer picker, and a button that enlarges it over the page. Its children draw on it as a layer
 * of the page's own (MapShape, MapTracks, MapMarkers, MapShapeEditor), and get the map via context.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { ActionIcon, Box, Loader, Stack, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Vendored copy of leaflet/dist/leaflet.css with the PNG icon urls replaced
// by inline SVG (deno bundle has no image loader)
import './leaflet.css';
import { MapContext, MapControlsContext, MapEnlargedContext, MapLayerContext, type MapLayerReport, useMap } from './context.ts';
import { type MapLayerEntry, mapLayers, mapStyles, type MapTiles } from '../../signals/nav.ts';
import { mapHome } from '../../signals/config.ts';
import type { GeoBounds, PositionPoint } from './types.ts';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from './defaults.ts';
import { defaultMapStyle } from './choice.ts';
import { MAP_CONTROL_Z } from './MapControl.tsx';
import { MapPicker } from './MapPicker.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { RoutePanel } from '../Surface/SurfaceRouter.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/** Which of a map's controls it draws. */
export type MapControls = {
  /** The style picker. */
  style?: boolean;
  /** The layer picker. */
  layers?: boolean;
  /** A button that enlarges the map over the page, with every control. */
  fullscreen?: boolean;
};

/** One layer's settings, as its route's query takes them: a list is the key once for each item. */
export type MapLayerSettings = Record<string, string | number | boolean | string[]>;

/** What a map draws unless told otherwise: the style picker, as Leaflet's own switcher once was. */
const STYLE_PICKER: MapControls = { style: true };

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
  /**
   * Fit the view to what its layers say they show (`useMapExtent`), while neither `center` nor
   * `bounds` is given: a dashboard's map of the stops a layer draws.
   */
  fit?: boolean;
  onClick?: (point: PositionPoint) => void;
  onMoveEnd?: (bounds: GeoBounds, zoom: number) => void;
  /**
   * The style, by its id among the navigation's map styles (`ui.map`, `ui.satellite`). Absent, the
   * map keeps its own, starting on the reader's (`CFG_USER_MAP_STYLE`) or else the first. A pick in
   * the picker is reported through `onMapStyleChange`, and a page that feeds it back finds that
   * style already showing.
   */
  mapStyle?: string;
  onMapStyleChange?: (id: string) => void;
  /**
   * The layers drawn over the style, by id among the navigation's map layers. Absent, the map keeps
   * its own, starting with `defaultLayers`, else none. A change in the picker is reported through
   * `onLayersChange`.
   */
  layers?: string[];
  defaultLayers?: string[];
  onLayersChange?: (ids: string[]) => void;
  /** Each layer's settings by its id, given to a layer drawn by a route as its query. */
  layerSettings?: Record<string, MapLayerSettings>;
  /** Which controls it draws; the style picker alone when not given. */
  controls?: MapControls;
  /** The title over the map enlarged by its full-screen button. */
  title?: string;
  /** Told when the map is enlarged over the page and when that closes: a page that handles Escape itself leaves it to the map then. */
  onEnlargedChange?: (enlarged: boolean) => void;
  style?: CSSProperties;
  children?: ReactNode;
};

function toGeoBounds(b: L.LatLngBounds): GeoBounds {
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

const toLatLngBounds = (b: GeoBounds): L.LatLngBounds => L.latLngBounds([b.south, b.west], [b.north, b.east]);

/** Room left around fitted bounds, in pixels. */
const FIT_PADDING: L.PointTuple = [20, 20];

/** Tile sets of a layer stand above the style's, which keep Leaflet's 1, in the order the layers come. */
const LAYER_TILES_Z = 10;

/** As the lightbox's other dialogs, over its own layers. */
const ENLARGED_Z = 300;

/** The box all of `boxes` lie in; undefined for none. */
const unionOf = (boxes: GeoBounds[]): GeoBounds | undefined =>
  boxes.length === 0 ? undefined : boxes.reduce((all, box) => ({
    north: Math.max(all.north, box.north),
    south: Math.min(all.south, box.south),
    east: Math.max(all.east, box.east),
    west: Math.min(all.west, box.west),
  }));

const sameBox = (a: GeoBounds | undefined, b: GeoBounds | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.north === b.north && a.south === b.south && a.east === b.east && a.west === b.west);

/** A layer's route with its settings as the query. */
const layerPath = (route: string, settings: MapLayerSettings | undefined): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(settings ?? {})) {
    for (const each of Array.isArray(value) ? value : [value]) query.append(key, String(each));
  }
  const text = query.toString();
  return text ? `${route}?${text}` : route;
};

/** A layer of tile sets, laid over the style above those of the layers before it. */
function LayerTiles({ tiles, index }: { tiles: MapTiles[]; index: number }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup(tiles.map((each) => L.tileLayer(each.url, { ...(each.options as L.TileLayerOptions), zIndex: LAYER_TILES_Z + index })));
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, tiles, index]);
  return null;
}

/** One layer turned on: its tile sets, or its module's route drawn inside the map with its settings, reporting as itself. */
function DrawnLayer({ layer, index, settings, report }: { layer: MapLayerEntry; index: number; settings?: MapLayerSettings; report: MapLayerReport }) {
  if (layer.tiles) return <LayerTiles tiles={layer.tiles} index={index} />;
  if (!layer.route) return null;
  return (
    <MapLayerContext.Provider value={report}>
      <RoutePanel path={layerPath(layer.route, settings)} loading={null} failed={null} />
    </MapLayerContext.Provider>
  );
}

/** What the layers have told the map, by layer id (`''` for the page's own children). */
function useLayerReports() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [extents, setExtents] = useState<Record<string, GeoBounds>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const reporters = useRef(new Map<string, MapLayerReport>());
  const reportFor = useCallback((id: string): MapLayerReport => {
    let report = reporters.current.get(id);
    if (!report) {
      report = {
        busy: (on) => setBusy((was) => was.has(id) === on ? was : new Set(on ? [...was, id] : [...was].filter((each) => each !== id))),
        extent: (box) =>
          setExtents((was) => {
            if (sameBox(was[id], box)) return was;
            const { [id]: _gone, ...rest } = was;
            return box ? { ...rest, [id]: box } : rest;
          }),
        note: (note) =>
          setNotes((was) => {
            if (was[id] === note) return was;
            const { [id]: _gone, ...rest } = was;
            return note ? { ...rest, [id]: note } : rest;
          }),
      };
      reporters.current.set(id, report);
    }
    return report;
  }, []);
  return { busy, extents, notes, reportFor };
}

export function MapView(
  {
    center,
    zoom,
    bounds,
    fit = false,
    onClick,
    onMoveEnd,
    mapStyle,
    onMapStyleChange,
    layers,
    defaultLayers,
    onLayersChange,
    layerSettings,
    controls = STYLE_PICKER,
    title,
    onEnlargedChange,
    style,
    children,
  }: MapViewProps,
) {
  useSignals();
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const [topRight, setTopRight] = useState<HTMLElement | null>(null);
  const [topLeft, setTopLeft] = useState<HTMLElement | null>(null);
  const places = useMemo(() => ({ 'top-right': topRight, 'top-left': topLeft }), [topRight, topLeft]);
  const { busy, extents, notes, reportFor } = useLayerReports();

  const styles = mapStyles();
  const offered = mapLayers();
  const [ownStyle, setOwnStyle] = useState<string>();
  const [ownLayers, setOwnLayers] = useState<string[]>(defaultLayers ?? []);
  const styleId = mapStyle ?? ownStyle ?? defaultMapStyle();
  const shown = layers ?? ownLayers;
  const drawn = offered.filter((layer) => shown.includes(layer.id));

  const pickStyle = (id: string) => {
    if (mapStyle === undefined) setOwnStyle(id);
    onMapStyleChange?.(id);
  };
  const pickLayers = (ids: string[]) => {
    if (layers === undefined) setOwnLayers(ids);
    onLayersChange?.(ids);
  };

  /** The map enlarged over the page: where it looked, with what, when the button was pressed. */
  const [enlarged, setEnlarged] = useState<{ center: PositionPoint; zoom: number; style?: string; layers: string[] } | null>(null);
  const enlargedChanged = useRef(onEnlargedChange);
  enlargedChanged.current = onEnlargedChange;
  const isEnlarged = enlarged !== null;
  // Told when it opens, and when it closes or goes with the map.
  useEffect(() => {
    if (!isEnlarged) return;
    enlargedChanged.current?.(true);
    return () => enlargedChanged.current?.(false);
  }, [isEnlarged]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const m = L.map(el, {
      center: center ?? DEFAULT_CENTER,
      zoom: zoom ?? (center ? DEFAULT_ZOOM : mapHome.value.zoom),
      // Wheel and pinch zoom; buttons would only cover the map.
      zoomControl: false,
    });
    // A map given bounds starts on them, rather than flying in from the default view and
    // reporting that view as its first.
    if (bounds) m.fitBounds(toLatLngBounds(bounds), { padding: FIT_PADDING, animate: false });

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

  // The style's tile sets, swapped whole when it changes.
  const styleRef = useRef<{ id: string; group: L.LayerGroup } | null>(null);
  useEffect(() => {
    if (!map) return;
    const def = styles.find((each) => each.id === styleId) ?? styles[0];
    if (styleRef.current?.id === def?.id) return;
    styleRef.current?.group.remove();
    styleRef.current = def ? { id: def.id, group: L.layerGroup(def.tiles.map((tiles) => L.tileLayer(tiles.url, tiles.options as L.TileLayerOptions))).addTo(map) } : null;
  }, [map, styleId, styles]);

  useEffect(() => {
    if (!map || bounds) return;
    map.setView(center ?? DEFAULT_CENTER, zoom ?? map.getZoom());
  }, [map, center?.lat, center?.lng, zoom]);

  useEffect(() => {
    if (!map || !bounds) return;
    map.fitBounds(toLatLngBounds(bounds), { padding: FIT_PADDING });
  }, [map, bounds?.north, bounds?.south, bounds?.east, bounds?.west]);

  const extent = fit && !center && !bounds ? unionOf(Object.values(extents)) : undefined;
  useEffect(() => {
    if (!map || !extent) return;
    map.fitBounds(toLatLngBounds(extent), { padding: FIT_PADDING });
  }, [map, extent?.north, extent?.south, extent?.east, extent?.west]);

  useEffect(() => {
    if (!map || !onClick) return;
    const handler = (e: L.LeafletMouseEvent) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onClick]);

  // Reported once when the map is made and then on each move, not again when the callback
  // changes: a page's callback is remade with its URL, and the lightbox opening over the map is a
  // URL change that would ask the page to read the same viewport again.
  const onMoveEndRef = useRef(onMoveEnd);
  onMoveEndRef.current = onMoveEnd;
  useEffect(() => {
    if (!map) return;
    const handler = () => onMoveEndRef.current?.(toGeoBounds(map.getBounds()), map.getZoom());
    map.on('moveend', handler);
    // Report the initial viewport so pages can load data before any pan
    handler();
    return () => {
      map.off('moveend', handler);
    };
  }, [map]);

  const pickerStyles = controls.style ? styles : [];
  const pickerLayers = controls.layers ? offered : [];

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 200, ...style }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0, cursor: style?.cursor }} />
      {map && (
        <MapContext.Provider value={map}>
          <Stack className='mrx-map-corner' gap='xs' style={{ zIndex: MAP_CONTROL_Z }}>
            {(pickerStyles.length > 1 || pickerLayers.length > 0) && (
              <MapPicker
                styles={pickerStyles}
                style={styleRef.current?.id ?? styleId}
                onStyleChange={pickStyle}
                layers={pickerLayers}
                on={shown}
                onLayersChange={pickLayers}
                notes={notes}
              />
            )}
            {controls.fullscreen && (
              <Tooltip label='Enlarge the map' position='left'>
                <ActionIcon
                  className='mrx-map-button'
                  aria-label='Enlarge the map'
                  onClick={() => setEnlarged({ center: map.getCenter(), zoom: map.getZoom(), style: styleId, layers: shown })}
                >
                  <TablerIcon name='maximize' size={22} />
                </ActionIcon>
              </Tooltip>
            )}
            {/* What layers and the page put in the corner, under the map's own buttons. */}
            <div ref={setTopRight} style={{ display: 'contents' }} />
            {busy.size > 0 && (
              <Box className='mrx-map-loading' role='status' aria-label='Loading the map' style={{ position: 'static' }}>
                <Loader size={18} />
              </Box>
            )}
          </Stack>
          <div ref={setTopLeft} style={{ position: 'absolute', top: 10, left: 10, zIndex: MAP_CONTROL_Z, maxWidth: 'calc(100% - 84px)' }} />
          <MapControlsContext.Provider value={places}>
            {drawn.map((layer, index) => <DrawnLayer key={layer.id} layer={layer} index={index} settings={layerSettings?.[layer.id]} report={reportFor(layer.id)} />)}
            <MapLayerContext.Provider value={reportFor('')}>{children}</MapLayerContext.Provider>
          </MapControlsContext.Provider>
        </MapContext.Provider>
      )}
      {enlarged && (
        <Dialog opened onClose={() => setEnlarged(null)} size='screen' bleed title={title ?? 'Map'} icon='map' pattern='location' zIndex={ENLARGED_Z}>
          <MapEnlargedContext.Provider value>
            <EnlargedMap
              center={enlarged.center}
              zoom={enlarged.zoom}
              initialStyle={enlarged.style}
              initialLayers={enlarged.layers}
              layerSettings={layerSettings}
            >
              {children}
            </EnlargedMap>
          </MapEnlargedContext.Provider>
        </Dialog>
      )}
    </div>
  );
}

/** The map enlarged over the page: where the small one looked, with what, and every control; what is picked here stays here. */
function EnlargedMap({ center, zoom, initialStyle, initialLayers, layerSettings, children }: {
  center: PositionPoint;
  zoom: number;
  initialStyle?: string;
  initialLayers: string[];
  layerSettings?: Record<string, MapLayerSettings>;
  children?: ReactNode;
}) {
  const [style, setStyle] = useState(initialStyle);
  const [layers, setLayers] = useState(initialLayers);
  const opening = useRef({ center, zoom });
  return (
    <MapView
      center={opening.current.center}
      zoom={opening.current.zoom}
      mapStyle={style}
      onMapStyleChange={setStyle}
      layers={layers}
      onLayersChange={setLayers}
      layerSettings={layerSettings}
      controls={{ style: true, layers: true }}
      style={{ flex: 1, height: 'auto', minHeight: 0 }}
    >
      {children}
    </MapView>
  );
}
