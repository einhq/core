type SidebarSwipe = 'left' | 'right';

type SwipePoint = {
  x: number;
  y: number;
  time: number;
};

const MIN_DISTANCE_PX = 48;
/**
 * Steeper than the lightbox's: a page here also scrolls, and a thumb scrolling it draws an arc
 * with a fair sideways part.
 */
const AXIS_DOMINANCE = 1.5;
const MAX_DURATION_MS = 1000;

/** Which way one finger swiped across the page, or null for a tap, a scroll or a diagonal drag. */
export function sidebarSwipe(start: SwipePoint, end: SwipePoint): SidebarSwipe | null {
  const elapsed = end.time - start.time;
  if (elapsed < 0 || elapsed > MAX_DURATION_MS) return null;
  const dx = end.x - start.x;
  const horizontal = Math.abs(dx);
  if (horizontal < MIN_DISTANCE_PX || horizontal <= Math.abs(end.y - start.y) * AXIS_DOMINANCE) return null;
  return dx < 0 ? 'left' : 'right';
}

/**
 * Whether something between a touch's target and `root` takes sideways moves for itself: a field,
 * a slider, an element that refuses the browser's sideways pan (a map, the time rail, a story),
 * or one that scrolls sideways (a row of search results, a wide table).
 */
function ownsSidewaysTouch(target: Element, root: Element): boolean {
  if (target.closest('input, textarea, select, [role="slider"]') || (target as HTMLElement).isContentEditable) return true;
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    const style = getComputedStyle(el);
    const action = style.touchAction;
    if (action !== 'auto' && action !== 'manipulation' && !/pan-(x|left|right)/.test(action)) return true;
    if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth - el.clientWidth > 1) return true;
  }
  return false;
}

/**
 * Report one-finger sideways swipes that start inside `root()` and that nothing under the finger
 * takes for itself. A second finger cancels the touch, so a pinch never counts. Styles are read
 * only once a touch has qualified as a swipe, never while the page scrolls. Returns the cleanup.
 */
export function watchSidebarSwipe(root: () => Element | null, onSwipe: (swipe: SidebarSwipe) => void): () => void {
  let start: SwipePoint | null = null;
  const onStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && !event.defaultPrevented ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp } : null;
  };
  const onEnd = (event: TouchEvent) => {
    const from = start;
    start = null;
    const touch = event.changedTouches[0];
    if (!from || !touch || event.touches.length > 0 || event.defaultPrevented) return;
    const swipe = sidebarSwipe(from, { x: touch.clientX, y: touch.clientY, time: event.timeStamp });
    const shell = root();
    const target = event.target instanceof Element ? event.target : null;
    if (swipe && shell && target && shell.contains(target) && !ownsSidewaysTouch(target, shell)) onSwipe(swipe);
  };
  const onCancel = () => {
    start = null;
  };
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', onCancel);
  return () => {
    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onCancel);
  };
}
