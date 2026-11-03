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
  /** How many points are on the map, so growth can be appended. */
  count: number;
  color: string;
  faint: boolean;
};

const latLngs = (points: PositionPoint[]): [number, number][] => points.map((p) => [p.lat, p.lng]);

export function MapTracks({ tracks, fit = false, follow = false }: MapTracksProps) {
  const map = useMap();
  const layersRef = useRef(new Map<string, Drawn>());
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!map) return;
    const layers = layersRef.current;
    const seen = new Set<string>();

    for (const spec of tracks) {
      seen.add(spec.id);
      const color = spec.color ?? MARKER_COLOR;
      const faint = spec.faint === true;
      let drawn = layers.get(spec.id);

      // A recolor, or a line turning faint, cannot be appended to, so the line is rebuilt from scratch.
      if (drawn && (drawn.color !== color || drawn.faint !== faint)) {
        drawn.line.remove();
        drawn.under.remove();
        layers.delete(spec.id);
        drawn = undefined;
      }

      if (!drawn) {
        drawn = {
          under: faint ? L.layerGroup().addTo(map) : L.polyline([], { pane: 'casing', color: '#000', weight: 5, opacity: 0.85, interactive: false }).addTo(map),
          line: L.polyline([], faint ? { color, weight: 2, opacity: 0.6, dashArray: '4 6' } : { color, weight: 3, opacity: 0.8 }).addTo(map),
          count: 0,
          color,
          faint,
        };
        layers.set(spec.id, drawn);
      }

      const under = drawn.under;
      const dot = (point: [number, number]) => L.circleMarker(point, { radius: 3, color, weight: 1, opacity: 0.8, fillOpacity: 0.4, interactive: false });

      if (spec.points.length >= drawn.count) {
        for (let i = drawn.count; i < spec.points.length; i++) {
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
      drawn.count = spec.points.length;

      if (spec.label) drawn.line.bindTooltip(spec.label, { sticky: true });
      else drawn.line.unbindTooltip();
    }

    for (const [id, drawn] of layers) {
      if (seen.has(id)) continue;
      drawn.line.remove();
      drawn.under.remove();
      layers.delete(id);
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
      for (const drawn of layers.values()) {
        drawn.line.remove();
        drawn.under.remove();
      }
      layers.clear();
    };
  }, [map]);

  return null;
}
