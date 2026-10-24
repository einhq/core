/**
 * Back to the top of the page — the real top, not the top of what is loaded.
 *
 * A list that loads around a point, like a timeline seeked by its rail, has
 * nothing above its first loaded picture until it is asked for, so scrolling
 * to 0 alone lands on that picture. Such a list listens for `TO_TOP_EVENT` and
 * lets go of its point, loading from the start again.
 */
export const TO_TOP_EVENT = 'mrx:to-top';

export function scrollToTop(): void {
  globalThis.dispatchEvent(new Event(TO_TOP_EVENT));
  // Instant: a smooth scroll over a long list stops wherever loading above it holds it.
  globalThis.scrollTo({ top: 0, behavior: 'instant' });
}
