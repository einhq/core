/**
 * MapShape — renders a position shape: polygon ring, circle (point + radius)
 * or a plain pin for a bare point.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { useEffect } from 'react';
import { useMap } from './context.ts';
import { MARKER_COLOR, pinIcon } from './icons.ts';
import type { PositionShape } from './types.ts';

export type MapShapeProps = {
  shape: PositionShape;
  color?: string;
  /** Fit the map view to the shape when it (re)renders. */
  fit?: boolean;
};

export function MapShape({ shape, color = MARKER_COLOR, fit = false }: MapShapeProps) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    let layer: L.Layer;
    if (shape.polygon && shape.polygon.length >= 3) {
      layer = L.polygon(shape.polygon.map((p) => [p.lat, p.lng] as [number, number]), {
        color,
        weight: 2,
        fillOpacity: 0.15,
      });
    } else if (shape.radius && shape.radius > 0) {
      layer = L.circle([shape.lat, shape.lng], {
        radius: shape.radius,
        color,
        weight: 2,
        fillOpacity: 0.15,
      });
    } else {
      layer = L.marker([shape.lat, shape.lng], { icon: pinIcon(color) });
    }

    layer.addTo(map);

    if (fit) {
      if (layer instanceof L.Polygon || layer instanceof L.Circle) {
        map.fitBounds(layer.getBounds(), { padding: [30, 30] });
      } else {
        map.setView([shape.lat, shape.lng], Math.max(map.getZoom(), 15));
      }
    }

    return () => {
      layer.remove();
    };
  }, [map, JSON.stringify(shape), color, fit]);

  return null;
}
