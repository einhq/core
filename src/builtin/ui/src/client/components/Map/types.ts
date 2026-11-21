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

/**
 * A short label in its own colours, as a line's badge: `color` is the writing, `border` the frame
 * (`background` unless given), `dot` the dot on the spot under it (`border` unless given).
 */
export type MapMarkerTag = {
  text: string;
  background: string;
  color: string;
  border?: string;
  dot?: string;
};

export type MapMarkerSpec = {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  /** Renders the marker as this tag over a dot on the spot. */
  tag?: MapMarkerTag;
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
  /** Drawn under every marker that is not: a place, under the vehicles passing it. */
  below?: boolean;
  onClick?: () => void;
  /** Pointer entering (true) or leaving (false) the marker. */
  onHover?: (over: boolean) => void;
};
