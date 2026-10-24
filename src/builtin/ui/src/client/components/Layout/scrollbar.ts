/** The shortest the thumb gets on a very long scroll, so it stays something to take hold of. */
const MIN_THUMB = 32;
/** How long the thumb stays after the scroll stops, where it only shows while scrolling. */
const SCROLLING_LINGER_MS = 800;

/** What a scrollbar is a view of. */
type ScrollSource = {
  /** What scrolls: the document's scrolling element for the page, or a box. */
  element: HTMLElement;
  /** Where its scroll events fire: the window for the page, the box itself otherwise. */
  events: EventTarget;
  /** Calls `changed` whenever the scroll's length may have changed, until the returned stop. */
  watch: (changed: () => void) => () => void;
};

/**
 * Draws `thumb` in `track` as a view of `source`'s scroll, and lets it be dragged: a press on the
 * track brings the thumb under the pointer and drags from there. Wheel, keys and touch go on
 * driving the scroll itself. Returns the cleanup.
 *
 * The track may be shorter than what scrolls is tall, where something stands over the rest of it
 * (the app header over the page, a dialog's bar of buttons over its body): the thumb is sized by
 * what of the scroll shows in the track's length. `data-scrollable` is on the track while there is
 * anything to scroll, `data-scrolling` while it scrolls and a moment after, and `data-dragging`
 * while the thumb is held.
 */
export function bindScrollbar(track: HTMLElement, thumb: HTMLElement, source: ScrollSource): () => void {
  const { element } = source;
  // The geometry the last draw used, which a drag maps the pointer through.
  let range = 0;
  let travel = 0;
  let frame = 0;
  let linger = 0;

  const draw = () => {
    frame = 0;
    const length = track.clientHeight;
    const covered = element.clientHeight - length;
    range = Math.max(0, element.scrollHeight - element.clientHeight);
    const scrollable = range >= 1 && length > 0;
    track.toggleAttribute('data-scrollable', scrollable);
    if (!scrollable) return;
    const size = Math.max(MIN_THUMB, Math.round(length * length / (element.scrollHeight - covered)));
    travel = Math.max(0, length - size);
    thumb.style.height = `${size}px`;
    thumb.style.transform = `translateY(${Math.round(travel * Math.min(1, element.scrollTop / range))}px)`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const onScroll = () => {
    schedule();
    track.setAttribute('data-scrolling', '');
    clearTimeout(linger);
    linger = setTimeout(() => track.removeAttribute('data-scrolling'), SCROLLING_LINGER_MS);
  };

  const scrollTo = (top: number) => element.scrollTo({ top, behavior: 'instant' });
  let drag: { pointer: number; y: number; top: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || range < 1) return;
    event.preventDefault();
    if (event.target !== thumb) {
      // Centre the thumb on the press, then drag from there.
      const rect = track.getBoundingClientRect();
      const offset = event.clientY - rect.top - thumb.offsetHeight / 2;
      scrollTo(travel > 0 ? range * Math.max(0, Math.min(1, offset / travel)) : 0);
    }
    drag = { pointer: event.pointerId, y: event.clientY, top: element.scrollTop };
    track.setPointerCapture(event.pointerId);
    track.setAttribute('data-dragging', '');
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer || travel <= 0) return;
    scrollTo(drag.top + (event.clientY - drag.y) * range / travel);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
    track.removeAttribute('data-dragging');
  };

  draw();
  source.events.addEventListener('scroll', onScroll, { passive: true });
  globalThis.addEventListener('resize', schedule);
  const unwatch = source.watch(schedule);
  const trackObserver = new ResizeObserver(schedule);
  trackObserver.observe(track);
  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);
  return () => {
    source.events.removeEventListener('scroll', onScroll);
    globalThis.removeEventListener('resize', schedule);
    unwatch();
    trackObserver.disconnect();
    track.removeEventListener('pointerdown', onPointerDown);
    track.removeEventListener('pointermove', onPointerMove);
    track.removeEventListener('pointerup', onPointerUp);
    track.removeEventListener('pointercancel', onPointerUp);
    cancelAnimationFrame(frame);
    clearTimeout(linger);
  };
}
