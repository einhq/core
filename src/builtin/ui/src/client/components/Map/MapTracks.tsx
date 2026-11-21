/**
 * MapTracks — declarative set of tracks, diffed by id.
 *
 * Each line is a colored polyline over a slightly wider black casing: the halo is what keeps a light-colored track readable
 * over satellite imagery and keeps two tracks apart where they overlap. Casings
 * live in their own pane (created by MapView, z-index 399, below the overlay
 * pane) so no casing ever covers another track's color, whatever order they were
 * added in.
 *
 * A line that only grew appends its new tail rather than being redrawn, so a
 * live track being followed does not rebuild its whole geometry per point.
 *
 * A faint line is what a track left out: thin, dashed and without a casing,
 * with a dot on every point so that a single point shows too.
 *
 * Tracks are stacked in the order given, the last on top, and `opacity` dims
 * one, casing and all. A line with `fade` fades out to nothing towards one end,
 * casing and all, along the straight line between its ends: a gradient in its
 * stroke, placed anew whenever its ends or the zoom change.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from './context.ts';
import { MARKER_COLOR } from './icons.ts';
import type { PositionPoint } from './types.ts';

export type MapTrackSpec = {
  id: string;
  points: PositionPoint[];
  color?: string;
  label?: string;
  /** Drawn faintly, with a dot on every point: what a track left out. */
  faint?: boolean;
  /** How strongly it is drawn, from 0 to 1; 1 unless given. */
  opacity?: number;
  /** The end it fades out towards, to nothing, as a trail behind a vehicle does. */
  fade?: 'start' | 'end';
};

export type MapTracksProps = {
  tracks: MapTrackSpec[];
  /** Fit the map to everything drawn, once, when the first geometry arrives. */
  fit?: boolean;
  /** Pan to keep the newest point of the last track in view (live following). */
  follow?: boolean;
};

type Drawn = {
  line: L.Polyline;
  /** The black halo under a line, or its dots when it is faint. */
  under: L.Polyline | L.LayerGroup;
  color: string;
  faint: boolean;
  opacity: number;
  /** The tooltip bound to the line. */
  label?: string;
  fade?: 'start' | 'end';
  /** The gradients a fading line and its casing are stroked with. */
  gradients: SVGLinearGradientElement[];
};

const SVG = 'http://www.w3.org/2000/svg';

let gradientCount = 0;

/** A gradient in `defs` from `color` to nothing towards the `fade` end, in the map's layer pixels, and the stroke naming it. */
const gradient = (defs: SVGDefsElement, color: string, fade: 'start' | 'end'): { element: SVGLinearGradientElement; stroke: string } => {
  const element = document.createElementNS(SVG, 'linearGradient');
  element.id = `ein-track-fade-${++gradientCount}`;
  element.setAttribute('gradientUnits', 'userSpaceOnUse');
  for (const [offset, opacity] of fade === 'start' ? [[0, 0], [1, 1]] : [[0, 1], [1, 0]]) {
    const stop = document.createElementNS(SVG, 'stop');
    stop.setAttribute('offset', String(offset));
    stop.setAttribute('stop-color', color);
    stop.setAttribute('stop-opacity', String(opacity));
    element.append(stop);
  }
  defs.append(element);
  return { element, stroke: `url(#${element.id})` };
};

/** Lays `drawn`'s gradients from its first point to its last, where they are on the map now. */
const shade = (map: L.Map, drawn: Drawn) => {
  const points = drawn.line.getLatLngs() as L.LatLng[];
  if (!drawn.gradients.length || points.length < 2) return;
  const [a, b] = [map.latLngToLayerPoint(points[0]), map.latLngToLayerPoint(points.at(-1)!)];
  for (const element of drawn.gradients) {
    element.setAttribute('x1', String(a.x));
    element.setAttribute('y1', String(a.y));
    // Ends on the same spot would leave the gradient nowhere to run, and the line unpainted.
    element.setAttribute('x2', String(b.x === a.x && b.y === a.y ? a.x + 1 : b.x));
    element.setAttribute('y2', String(b.y));
  }
};

const drop = (drawn: Drawn) => {
  drawn.line.remove();
  drawn.under.remove();
  for (const element of drawn.gradients) element.remove();
};

const latLngs = (points: PositionPoint[]): [number, number][] => points.map((p) => [p.lat, p.lng]);

export function MapTracks({ tracks, fit = false, follow = false }: MapTracksProps) {
  const map = useMap();
  const layersRef = useRef(new Map<string, Drawn>());
  const fittedRef = useRef(false);
  const defsRef = useRef<SVGDefsElement | undefined>(undefined);

  // The fading lines' gradients, in an SVG of their own; a line's stroke names one wherever it is drawn.
  useEffect(() => {
    if (!map) return;
    const holder = document.createElementNS(SVG, 'svg');
    holder.setAttribute('width', '0');
    holder.setAttribute('height', '0');
    holder.style.position = 'absolute';
    const defs = document.createElementNS(SVG, 'defs');
    holder.append(defs);
    map.getContainer().append(holder);
    defsRef.current = defs;
    // A zoom moves every point to other layer pixels.
    const reshade = () => {
      for (const drawn of layersRef.current.values()) shade(map, drawn);
    };
    map.on('zoomend viewreset', reshade);
    return () => {
      map.off('zoomend viewreset', reshade);
      holder.remove();
      defsRef.current = undefined;
    };
  }, [map]);

  useEffect(() => {
    const defs = defsRef.current;
    if (!map || !defs) return;
    const layers = layersRef.current;
    const seen = new Set<string>();
    let added = false;

    for (const spec of tracks) {
      seen.add(spec.id);
      const color = spec.color ?? MARKER_COLOR;
      const faint = spec.faint === true;
      const opacity = spec.opacity ?? 1;
      const fade = spec.fade;
      let drawn = layers.get(spec.id);

      // A recolor, a line turning faint or fading another way, cannot be appended to, so the line is rebuilt from scratch.
      if (drawn && (drawn.color !== color || drawn.faint !== faint || drawn.fade !== fade)) {
        drop(drawn);
        layers.delete(spec.id);
        drawn = undefined;
      }

      if (!drawn) {
        const [lineFade, casingFade] = fade ? [gradient(defs, color, fade), gradient(defs, '#000', fade)] : [];
        drawn = {
          under: faint
            ? L.layerGroup().addTo(map)
            : L.polyline([], { pane: 'casing', color: casingFade?.stroke ?? '#000', weight: 5, opacity: 0.85 * opacity, interactive: false }).addTo(map),
          line: L.polyline(
            [],
            faint
              ? { color: lineFade?.stroke ?? color, weight: 2, opacity: 0.6 * opacity, dashArray: '4 6' }
              : { color: lineFade?.stroke ?? color, weight: 3, opacity: 0.8 * opacity },
          ).addTo(map),
          color,
          faint,
          opacity,
          fade,
          gradients: [lineFade, casingFade].flatMap((each) => each ? [each.element] : []),
        };
        layers.set(spec.id, drawn);
        added = true;
      } else if (drawn.opacity !== opacity) {
        drawn.line.setStyle({ opacity: (faint ? 0.6 : 0.8) * opacity });
        if (drawn.under instanceof L.Polyline) drawn.under.setStyle({ opacity: 0.85 * opacity });
        drawn.opacity = opacity;
      }

      const under = drawn.under;
      const dot = (point: [number, number]) => L.circleMarker(point, { radius: 3, color, weight: 1, opacity: 0.8, fillOpacity: 0.4, interactive: false });

      // A track that grew keeps what is drawn and takes the new points; one whose drawn points moved,
      // as a trail does behind a vehicle, is drawn anew.
      const drawnPoints = drawn.line.getLatLngs() as L.LatLng[];
      const grew = spec.points.length >= drawnPoints.length &&
        drawnPoints.every((point, i) => point.lat === spec.points[i].lat && point.lng === spec.points[i].lng);
      if (grew) {
        for (let i = drawnPoints.length; i < spec.points.length; i++) {
          const point: [number, number] = [spec.points[i].lat, spec.points[i].lng];
          drawn.line.addLatLng(point);
          if (under instanceof L.Polyline) under.addLatLng(point);
          else under.addLayer(dot(point));
        }
      } else {
        drawn.line.setLatLngs(latLngs(spec.points));
        if (under instanceof L.Polyline) under.setLatLngs(latLngs(spec.points));
        else {
          under.clearLayers();
          for (const point of latLngs(spec.points)) under.addLayer(dot(point));
        }
      }

      shade(map, drawn);

      if (spec.label !== drawn.label) {
        if (spec.label) drawn.line.bindTooltip(spec.label, { sticky: true });
        else drawn.line.unbindTooltip();
        drawn.label = spec.label;
      }
    }

    for (const [id, drawn] of layers) {
      if (seen.has(id)) continue;
      drop(drawn);
      layers.delete(id);
    }

    // A line added now lies on top of all; the others are raised over it again in their order.
    if (added) {
      for (const spec of tracks) {
        const drawn = layers.get(spec.id)!;
        if (drawn.under instanceof L.Polyline) drawn.under.bringToFront();
        drawn.line.bringToFront();
      }
    }

    const drawnTracks = tracks.filter((spec) => spec.points.length > 0);
    if (drawnTracks.length === 0) return;

    if (fit && !fittedRef.current) {
      const bounds = L.latLngBounds(drawnTracks.flatMap((spec) => latLngs(spec.points)));
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
        fittedRef.current = true;
      }
    }

    if (follow) {
      const last = drawnTracks[drawnTracks.length - 1].points.at(-1)!;
      map.panTo([last.lat, last.lng]);
    }
  }, [map, tracks, fit, follow]);

  useEffect(() => {
    const layers = layersRef.current;
    return () => {
      for (const drawn of layers.values()) drop(drawn);
      layers.clear();
    };
  }, [map]);

  return null;
}
