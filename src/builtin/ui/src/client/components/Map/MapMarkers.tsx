/**
 * MapMarkers — declarative marker set, diffed by id. Pins by default,
 * thumbnails when a thumbnailUrl is given, a tag when a tag is.
 *
 * With `glide`, a marker that moves slides to its new spot over that many
 * milliseconds rather than jumping: a vehicle polled every few seconds drives
 * on. A zoom moves every marker at once, so gliding stops while one runs.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from './context.ts';
import { clusterIcon, numberedPinIcon, pileIcon, pinIcon, tagIcon, thumbnailIcon } from './icons.ts';
import type { MapMarkerSpec } from './types.ts';

export type MapMarkersProps = {
  markers: MapMarkerSpec[];
  /** How long a moved marker takes to reach its new spot, in milliseconds; it jumps unless given. */
  glide?: number;
};

export function MapMarkers({ markers, glide }: MapMarkersProps) {
  const map = useMap();
  const layersRef = useRef(new Map<string, L.Marker>());
  const zoomingRef = useRef(false);

  useEffect(() => {
    if (!map) return;
    const layers = layersRef.current;
    const seen = new Set<string>();

    for (const spec of markers) {
      seen.add(spec.id);

      const icon = spec.tag
        ? tagIcon(spec.tag)
        : spec.thumbnailUrl && spec.badge !== undefined
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
        const element = marker.getElement();
        if (element && !zoomingRef.current) element.style.transition = glide ? `transform ${glide}ms linear` : '';
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
  }, [map, markers, glide]);

  // A glide would carry each marker slowly to where a zoom puts it: Leaflet's own zoom transition
  // runs instead, and gliding takes up again once the markers are in their new places, which a
  // forced style read makes sure of before the next move.
  useEffect(() => {
    if (!map || !glide) return;
    const layers = layersRef.current;
    const start = () => {
      zoomingRef.current = true;
      for (const marker of layers.values()) {
        const element = marker.getElement();
        if (element) element.style.transition = '';
      }
    };
    const end = () => {
      void map.getContainer().offsetWidth;
      zoomingRef.current = false;
    };
    map.on('zoomstart', start).on('zoomend', end);
    return () => {
      map.off('zoomstart', start).off('zoomend', end);
    };
  }, [map, glide]);

  useEffect(() => {
    const layers = layersRef.current;
    return () => {
      for (const marker of layers.values()) marker.remove();
      layers.clear();
    };
  }, [map]);

  return null;
}
