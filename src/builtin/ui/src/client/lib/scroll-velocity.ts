/** Default boundary between deliberate browsing and travelling through a feed. */
const FAST_SCROLL_PX_PER_MS = 0.8;

type ScrollVelocityOptions = {
  threshold?: number;
  /** Samples farther apart than this begin a new gesture instead of averaging. */
  resetAfterMs?: number;
  /** Weight of the newest sample in the running velocity. */
  sampleWeight?: number;
};

/**
 * Small velocity gate shared by media windows.
 *
 * Positions may be page scroll offsets or an element's viewport coordinate;
 * only their absolute movement matters. Smoothing keeps one noisy wheel event
 * from blanking a slow browse, while resetting between gestures prevents a
 * previous fling from poisoning the next touch.
 */
export function createScrollVelocityGate(options: ScrollVelocityOptions = {}) {
  const threshold = options.threshold ?? FAST_SCROLL_PX_PER_MS;
  const resetAfterMs = options.resetAfterMs ?? 180;
  const sampleWeight = options.sampleWeight ?? 0.5;
  let previous: { position: number; time: number } | undefined;
  let velocity = 0;

  return {
    sample(position: number, time: number): boolean {
      if (!previous || time <= previous.time || time - previous.time > resetAfterMs) {
        previous = { position, time };
        velocity = 0;
        return false;
      }

      const elapsed = time - previous.time;
      const instantaneous = Math.abs(position - previous.position) / elapsed;
      velocity = velocity === 0 ? instantaneous : velocity * (1 - sampleWeight) + instantaneous * sampleWeight;
      previous = { position, time };
      return velocity >= threshold;
    },

    reset(): void {
      previous = undefined;
      velocity = 0;
    },
  };
}
