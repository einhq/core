import { useMemo } from 'react';
import type { DeviceHistory } from '@ein/api';
import { MapMarkers } from '../Map/MapMarkers.tsx';
import { MapTracks, type MapTrackSpec } from '../Map/MapTracks.tsx';
import { MapView } from '../Map/MapView.tsx';
import type { GeoBounds } from '../Map/types.ts';

type Fix = NonNullable<DeviceHistory['fixes']>[number];

/** Longer than this between two fixes and the line is broken: the device was off or out of reach, not travelling straight. */
const GAP_MS = 60 * 60 * 1000;
/** Fixes closer together than this, in degrees, are shown around the last at a street's zoom rather than fitted. */
const SPOT = 0.002;

/** Fixes as lines, one per run without a gap. */
const runsOf = (fixes: Fix[]): MapTrackSpec[] => {
  const runs: MapTrackSpec[] = [];
  let previous: number | undefined;
  for (const fix of fixes) {
    const at = Date.parse(fix.at);
    if (runs.length === 0 || previous === undefined || at - previous > GAP_MS) runs.push({ id: fix.at, points: [] });
    runs[runs.length - 1].points.push({ lat: fix.lat, lng: fix.lng });
    previous = at;
  }
  return runs;
};

const boundsOf = (fixes: Fix[]): GeoBounds =>
  fixes.reduce(
    (bounds, fix) => ({
      north: Math.max(bounds.north, fix.lat),
      south: Math.min(bounds.south, fix.lat),
      east: Math.max(bounds.east, fix.lng),
      west: Math.min(bounds.west, fix.lng),
    }),
    { north: -90, south: 90, east: -180, west: 180 },
  );

/**
 * A track endpoint's fixes on a map fitted to them, with a pin where the last one is; fixes that
 * stayed in one spot are shown around it instead. `fixes` is never empty. A `small` map has no
 * layer switcher and leaves out the layers' details, such as sea marks.
 */
export function FixMap({ fixes, height, small = false }: { fixes: Fix[]; height: number | string; small?: boolean }) {
  const tracks = useMemo(() => runsOf(fixes), [fixes]);
  const bounds = useMemo(() => boundsOf(fixes), [fixes]);
  const last = fixes[fixes.length - 1];
  const markers = useMemo(() => [{ id: 'last', lat: last.lat, lng: last.lng }], [last]);
  const spot = bounds.north - bounds.south < SPOT && bounds.east - bounds.west < SPOT;
  return (
    <MapView
      bounds={spot ? undefined : bounds}
      center={spot ? last : undefined}
      zoom={spot ? 16 : undefined}
      style={{ height, minHeight: height }}
      layerSwitcher={!small}
      details={!small}
    >
      <MapTracks tracks={tracks} />
      <MapMarkers markers={markers} />
    </MapView>
  );
}
