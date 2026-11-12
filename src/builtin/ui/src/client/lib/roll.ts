/**
 * Where a rolling list rests, as offsets along its axis from the start of its first copy: each
 * line of rows (rows starting within a pixel of each other are one line, as a grid's row of tiles
 * is), then the start of the second copy (`loopAt`), which looks the same as the first and is where
 * it snaps back from. Offsets keep their fractions, so the snap back moves nothing on the screen.
 */
export const rollStops = (starts: number[], loopAt: number): number[] => {
  const stops = [0];
  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start > stops[stops.length - 1] + 1 && start < loopAt - 1) stops.push(start);
  }
  return [...stops, loopAt];
};
