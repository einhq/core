/** Where a map looks: the point at its middle, and how close, as Leaflet's zoom. */
export type MapPosition = { lat: number; lng: number; zoom: number };

/** The closest and the furthest a map may open: a house, and the whole world. */
export const MAP_ZOOM_RANGE = { min: 2, max: 18 } as const;

/**
 * A `position` setting's value, `lat, lng, zoom` such as `51.5074, -0.1278, 11`, or nothing when it
 * is not one: three numbers, a latitude within ±90, a longitude within ±180 and a whole zoom within
 * `MAP_ZOOM_RANGE`.
 */
export const parseMapPosition = (value: string): MapPosition | undefined => {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !/^-?\d+(\.\d+)?$/.test(part))) return undefined;
  const [lat, lng, zoom] = parts.map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  if (!Number.isInteger(zoom) || zoom < MAP_ZOOM_RANGE.min || zoom > MAP_ZOOM_RANGE.max) return undefined;
  return { lat, lng, zoom };
};

/** A map position as a `position` setting writes it, to four decimals: about ten metres. */
export const formatMapPosition = ({ lat, lng, zoom }: MapPosition): string => `${lat.toFixed(4)}, ${lng.toFixed(4)}, ${Math.round(zoom)}`;
