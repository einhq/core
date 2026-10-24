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
  casing: L.Polyline;
  /** How many points are on the map, so growth can be appended. */
  count: number;
  color: string;
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
      let drawn = layers.get(spec.id);

      // A recolor cannot be appended to, so the line is rebuilt from scratch.
      if (drawn && drawn.color !== color) {
        drawn.line.remove();
        drawn.casing.remove();
        layers.delete(spec.id);
        drawn = undefined;
      }

      if (!drawn) {
        drawn = {
          casing: L.polyline([], { pane: 'casing', color: '#000', weight: 5, opacity: 0.85, interactive: false }).addTo(map),
          line: L.polyline([], { color, weight: 3, opacity: 0.8 }).addTo(map),
          count: 0,
          color,
        };
        layers.set(spec.id, drawn);
      }

      if (spec.points.length >= drawn.count) {
        for (let i = drawn.count; i < spec.points.length; i++) {
          const point: [number, number] = [spec.points[i].lat, spec.points[i].lng];
          drawn.line.addLatLng(point);
          drawn.casing.addLatLng(point);
        }
      } else {
        drawn.line.setLatLngs(latLngs(spec.points));
        drawn.casing.setLatLngs(latLngs(spec.points));
      }
      drawn.count = spec.points.length;

      if (spec.label) drawn.line.bindTooltip(spec.label, { sticky: true });
      else drawn.line.unbindTooltip();
    }

    for (const [id, drawn] of layers) {
      if (seen.has(id)) continue;
      drawn.line.remove();
      drawn.casing.remove();
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
        drawn.casing.remove();
      }
      layers.clear();
    };
  }, [map]);

  return null;
}
