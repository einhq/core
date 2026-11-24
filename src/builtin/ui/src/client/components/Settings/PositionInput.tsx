// @ts-types="@types/leaflet"
import L from 'leaflet';
import { Box, CloseButton, Stack, TextInput } from '@mantine/core';
import { IconCurrentLocation } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { formatMapPosition, MAP_ZOOM_RANGE, type MapPosition, parseMapPosition } from '@ein/api';
import { MapView } from '../Map/MapView.tsx';
import { useMap } from '../Map/context.ts';
import { mapHome } from '../../signals/config.ts';

type PositionInputProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** What no position means, for a setting that may be left empty; absent, the field cannot be cleared. */
  emptyMeans?: string;
};

/**
 * A place on a map and how close to look at it, as a `position` setting holds it: a small map
 * whose middle, marked, and zoom are the value, beside the value as text. Panning or zooming the map
 * writes the value, a click moves the middle to the point clicked, and a position typed in moves
 * the map there. While the text is not a position the map stays where it was.
 */
export function PositionInput({ id, value, onChange, disabled, emptyMeans }: PositionInputProps) {
  const parsed = parseMapPosition(value);
  const shown = useRef<MapPosition>(parsed ?? mapHome.value);
  if (parsed) shown.current = parsed;
  const camera = shown.current;

  return (
    <Stack gap='xs'>
      <TextInput
        id={id}
        value={value}
        disabled={disabled}
        placeholder={emptyMeans ? `Empty means ${emptyMeans}` : undefined}
        error={value !== '' && !parsed ? `A latitude, a longitude and a zoom from ${MAP_ZOOM_RANGE.min} to ${MAP_ZOOM_RANGE.max}, such as 51.5074, -0.1278, 11` : undefined}
        rightSection={emptyMeans !== undefined && value !== '' && !disabled ? <CloseButton size='sm' aria-label='Clear' onClick={() => onChange('')} /> : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <Box pos='relative' h={220} style={{ borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}>
        <MapView
          center={{ lat: camera.lat, lng: camera.lng }}
          zoom={camera.zoom}
          layerSwitcher={false}
          details={false}
          onClick={disabled ? undefined : (point) => onChange(formatMapPosition({ ...point, zoom: camera.zoom }))}
          style={{ height: '100%' }}
        >
          <CameraReport camera={camera} disabled={disabled} onChange={onChange} />
        </MapView>
        <Box
          pos='absolute'
          top='50%'
          left='50%'
          style={{ transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 500, color: 'var(--mantine-color-red-6)', lineHeight: 0 }}
        >
          <IconCurrentLocation size={28} stroke={2.2} />
        </Box>
      </Box>
    </Stack>
  );
}

/**
 * Writes where the person moved the map as the value. A move that ends where `camera` asked the
 * map to be is the map following the value, not a change to it, so it writes nothing: otherwise
 * opening the field would mark it changed, and a position being typed would be rewritten under the
 * cursor. The page scrolls over the map rather than zooming it, so zooming is by its buttons,
 * a double click or a pinch.
 */
function CameraReport({ camera, disabled, onChange }: { camera: MapPosition; disabled?: boolean; onChange: (value: string) => void }) {
  const map = useMap();
  const latest = useRef({ camera, disabled, onChange });
  latest.current = { camera, disabled, onChange };

  useEffect(() => {
    if (!map) return;
    map.setMinZoom(MAP_ZOOM_RANGE.min);
    map.setMaxZoom(MAP_ZOOM_RANGE.max);
    map.scrollWheelZoom.disable();
    const buttons = L.control.zoom({ position: 'topleft' }).addTo(map);
    const moved = () => {
      if (latest.current.disabled) return;
      const center = map.wrapLatLng(map.getCenter());
      const next = formatMapPosition({ lat: center.lat, lng: center.lng, zoom: map.getZoom() });
      if (next !== formatMapPosition(latest.current.camera)) latest.current.onChange(next);
    };
    map.on('moveend', moved);
    return () => {
      map.off('moveend', moved);
      buttons.remove();
    };
  }, [map]);

  return null;
}
