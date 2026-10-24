/**
 * Geo types for the map components, in the position registry's JSON format.
 */

export type PositionPoint = {
  lat: number;
  lng: number;
};

export type GeoBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

/** Shape of a position: point, circle (radius) or polygon ring. */
export type PositionShape = PositionPoint & {
  radius?: number;
  polygon?: PositionPoint[];
};

export type MapMarkerSpec = {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  /** Renders the marker as a small thumbnail instead of a pin. */
  thumbnailUrl?: string;
  /** Renders the marker as a count circle (cluster), or with a thumbnail as a pile with this count on it. */
  badge?: number | string;
  /** Renders a numbered pin, tying this marker to the same number in a list. */
  pinNumber?: number | string;
  /** Fill for a pin or a count circle; any CSS colour, including a `var()`. */
  color?: string;
  /** Highlighted, and drawn above its neighbours. */
  active?: boolean;
  onClick?: () => void;
  /** Pointer entering (true) or leaving (false) the marker. */
  onHover?: (over: boolean) => void;
};
