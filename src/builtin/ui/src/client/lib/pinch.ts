/** How far two fingers must spread or close, as a ratio of where they started, to count as a pinch. */
const SPREAD = 1.25;
const SQUEEZE = 0.8;

/** The fewest and most pictures a phone's grid puts in a row. */
export const PHONE_COLUMNS_MIN = 2;
export const PHONE_COLUMNS_MAX = 5;

/**
 * What a two-finger gesture asks of a grid: fingers spread apart want bigger pictures, so one
 * fewer per row (-1); fingers closed together want more of them, one more per row (+1); anything
 * less is no change (0).
 */
export function pinchStep(startDistance: number, endDistance: number): -1 | 0 | 1 {
  if (startDistance <= 0) return 0;
  const ratio = endDistance / startDistance;
  return ratio >= SPREAD ? -1 : ratio <= SQUEEZE ? 1 : 0;
}

/** The column count after a pinch step, kept within the phone's range. */
export const stepColumns = (columns: number, step: number): number => Math.min(PHONE_COLUMNS_MAX, Math.max(PHONE_COLUMNS_MIN, columns + step));
