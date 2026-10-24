/**
 * MapMarkers — declarative marker set, diffed by id. Pins by default,
 * thumbnails when a thumbnailUrl is given.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from './context.ts';
import { clusterIcon, numberedPinIcon, pileIcon, pinIcon, thumbnailIcon } from './icons.ts';
import type { MapMarkerSpec } from './types.ts';

export type MapMarkersProps = {
  markers: MapMarkerSpec[];
};

export function MapMarkers({ markers }: MapMarkersProps) {
  const map = useMap();
  const layersRef = useRef(new Map<string, L.Marker>());

  useEffect(() => {
    if (!map) return;
    const layers = layersRef.current;
    const seen = new Set<string>();

    for (const spec of markers) {
      seen.add(spec.id);

      const icon = spec.thumbnailUrl && spec.badge !== undefined
        ? pileIcon(spec.thumbnailUrl, spec.badge)
        : spec.thumbnailUrl
        ? thumbnailIcon(spec.thumbnailUrl)
        : spec.badge !== undefined
        ? clusterIcon(spec.badge, spec.color)
        : spec.pinNumber !== undefined
        ? numberedPinIcon(spec.pinNumber, spec.active)
        : pinIcon(spec.color);

      let marker = layers.get(spec.id);
      if (!marker) {
        marker = L.marker([spec.lat, spec.lng], { icon }).addTo(map);
        layers.set(spec.id, marker);
      } else {
        marker.setLatLng([spec.lat, spec.lng]);
        marker.setIcon(icon);
      }

      // An active marker is bigger, so it has to sit above its neighbours or it
      // ends up half-hidden behind the very pins it is meant to stand out from.
      marker.setZIndexOffset(spec.active ? 1000 : 0);

      if (spec.label) {
        marker.bindTooltip(spec.label);
      }
      marker.off('click');
      if (spec.onClick) {
        marker.on('click', spec.onClick);
      }
      marker.off('mouseover').off('mouseout');
      if (spec.onHover) {
        const onHover = spec.onHover;
        marker.on('mouseover', () => onHover(true));
        marker.on('mouseout', () => onHover(false));
      }
    }

    for (const [id, marker] of layers) {
      if (!seen.has(id)) {
        marker.remove();
        layers.delete(id);
      }
    }
  }, [map, markers]);

  useEffect(() => {
    const layers = layersRef.current;
    return () => {
      for (const marker of layers.values()) marker.remove();
      layers.clear();
    };
  }, [map]);

  return null;
}
