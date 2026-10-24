/**
 * MapShapeEditor — interactive circle/polygon editing on the map.
 *
 * Fully controlled: renders `value` and reports every mutation via
 * `onChange`; the parent decides when the shape is valid to save (polygon
 * needs >= 3 vertices).
 *
 * Circle: click sets the center, drag the center pin to move, drag the east
 * handle to resize. Polygon: clicks append vertices, drag to move, click a
 * midpoint to insert, right-click a vertex to remove.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from './context.ts';
import { pinIcon, vertexIcon } from './icons.ts';
import type { PositionPoint, PositionShape } from './types.ts';

const DEFAULT_RADIUS = 250;
export const EDIT_COLOR = '#e8590c';

export type MapShapeEditorProps = {
  mode: 'circle' | 'polygon';
  value: PositionShape | null;
  onChange: (shape: PositionShape) => void;
};

function ringCenter(ring: PositionPoint[]): PositionPoint {
  const n = ring.length;
  return {
    lat: ring.reduce((s, p) => s + p.lat, 0) / n,
    lng: ring.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Point `radius` meters east of `center` (for the circle resize handle). */
function eastOf(center: PositionPoint, radius: number): PositionPoint {
  const lngOffset = radius / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return { lat: center.lat, lng: center.lng + lngOffset };
}

export function MapShapeEditor({ mode, value, onChange }: MapShapeEditorProps) {
  const map = useMap();
  const layersRef = useRef<L.Layer[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!map) return;

    const layers = layersRef.current;
    const add = <T extends L.Layer>(layer: T): T => {
      layer.addTo(map);
      layers.push(layer);
      return layer;
    };
    const emit = (shape: PositionShape) => onChangeRef.current(shape);

    const mapClick = (e: L.LeafletMouseEvent) => {
      const point = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (mode === 'circle') {
        if (!value) emit({ ...point, radius: DEFAULT_RADIUS });
      } else {
        const ring = [...(value?.polygon ?? []), point];
        emit({ ...ringCenter(ring), polygon: ring });
      }
    };
    map.on('click', mapClick);

    if (mode === 'circle' && value) {
      const radius = value.radius && value.radius > 0 ? value.radius : DEFAULT_RADIUS;
      const circle = add(L.circle([value.lat, value.lng], {
        radius,
        color: EDIT_COLOR,
        weight: 2,
        fillOpacity: 0.1,
      }));

      const center = add(L.marker([value.lat, value.lng], { icon: pinIcon(EDIT_COLOR), draggable: true }));
      const handlePos = eastOf(value, radius);
      const handle = add(L.marker([handlePos.lat, handlePos.lng], { icon: vertexIcon(), draggable: true }));

      center.on('drag', () => {
        const c = center.getLatLng();
        circle.setLatLng(c);
        const h = eastOf({ lat: c.lat, lng: c.lng }, circle.getRadius());
        handle.setLatLng([h.lat, h.lng]);
      });
      center.on('dragend', () => {
        const c = center.getLatLng();
        emit({ lat: c.lat, lng: c.lng, radius: circle.getRadius() });
      });

      handle.on('drag', () => {
        circle.setRadius(map.distance(circle.getLatLng(), handle.getLatLng()));
      });
      handle.on('dragend', () => {
        const c = circle.getLatLng();
        emit({ lat: c.lat, lng: c.lng, radius: Math.round(circle.getRadius()) });
      });
    }

    if (mode === 'polygon') {
      const ring = value?.polygon ?? [];
      const latlngs = ring.map((p) => [p.lat, p.lng] as [number, number]);

      if (ring.length >= 3) {
        add(L.polygon(latlngs, { color: EDIT_COLOR, weight: 2, fillOpacity: 0.1, interactive: false }));
      } else if (ring.length === 2) {
        add(L.polyline(latlngs, { color: EDIT_COLOR, weight: 2, dashArray: '6 4', interactive: false }));
      }

      ring.forEach((p, i) => {
        const vertex = add(L.marker([p.lat, p.lng], { icon: vertexIcon(), draggable: true }));

        vertex.on('dragend', () => {
          const ll = vertex.getLatLng();
          const next = ring.map((q, j) => (j === i ? { lat: ll.lat, lng: ll.lng } : q));
          emit({ ...ringCenter(next), polygon: next });
        });

        vertex.on('contextmenu', (e) => {
          L.DomEvent.stop(e);
          const next = ring.filter((_, j) => j !== i);
          if (next.length > 0) {
            emit({ ...ringCenter(next), polygon: next });
          }
        });
      });

      // Midpoint markers insert a vertex on the edge between i and i+1
      if (ring.length >= 2) {
        const edges = ring.length >= 3 ? ring.length : ring.length - 1;
        for (let i = 0; i < edges; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
          const marker = add(L.marker([mid.lat, mid.lng], { icon: vertexIcon(false) }));

          marker.on('click', (e) => {
            L.DomEvent.stop(e);
            const next = [...ring.slice(0, i + 1), mid, ...ring.slice(i + 1)];
            emit({ ...ringCenter(next), polygon: next });
          });
        }
      }
    }

    return () => {
      map.off('click', mapClick);
      for (const layer of layers) layer.remove();
      layers.length = 0;
    };
  }, [map, mode, JSON.stringify(value)]);

  return null;
}
