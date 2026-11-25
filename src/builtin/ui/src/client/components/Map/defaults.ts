import { mapHome } from '../../signals/config.ts';
import type { PositionPoint } from './types.ts';

/** Where a map opens when it is given no center: `mapHome`'s point, read each time it is used. */
export const DEFAULT_CENTER: PositionPoint = {
  get lat() {
    return mapHome.value.lat;
  },
  get lng() {
    return mapHome.value.lng;
  },
};

/** How close a map given a center but no zoom looks. One given neither opens at `mapHome`'s zoom. */
export const DEFAULT_ZOOM = 12;
