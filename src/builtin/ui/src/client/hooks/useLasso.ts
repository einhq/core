import { useEffect, useRef, useState } from 'react';
import { bandRect, edgeSpeed, type LassoMode, lassoMode, type LassoRect, pastThreshold } from '../lib/lasso.ts';

export type { LassoMode, LassoRect } from '../lib/lasso.ts';

/** Where a press never starts a lasso: controls, menus, what can be dragged, and what opts out. */
const NOT_FROM = 'button, a[href], input, textarea, select, label, [role="menu"], [role="menuitem"], [role="checkbox"], [draggable="true"], [data-no-lasso]';

export type LassoOptions = {
  /** Off, a press does nothing here (a phone, a dialog open). */
  enabled: boolean;
  /** Where a lasso may start: presses inside it. */
  root: HTMLElement | null;
  /** Whether a press on `target` may start a lasso, besides the controls it never starts on. */
  canStart?: (target: Element) => boolean;
  /** Px at the top of the window under the page's headers, which the scrolling edge sits below. */
  topInset?: number;
  /** The lasso has started, with what keys said: the page keeps what was selected then. */
  onStart: (mode: LassoMode) => void;
  /** The band as it is now, in page coordinates (scrolled with the page), at most once a frame. */
  onBand: (band: LassoRect, mode: LassoMode) => void;
  /** The pointer came up: the band stands. */
  onEnd?: () => void;
  /** Escape: the page puts back what was selected when it started. */
  onCancel?: () => void;
};

/**
 * A rubber band over a page, for a mouse: it starts on a press in `root` (not on a control, nor
 * on anything draggable) once the pointer has moved 4 px, and draws its own band, fixed over the
 * page, without a render. Shift held at the start adds to the selection, Alt takes from it,
 * otherwise it replaces it; the page is called with the band once a frame and decides what it
 * takes. Near the window's top (under `topInset`) or bottom edge the page scrolls, faster nearer
 * the edge, and the band grows with it. The click that ends a lasso is swallowed, so a tile it
 * ends on does not open.
 */
export function useLasso(options: LassoOptions): { active: boolean } {
  const [active, setActive] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled, root } = options;

  useEffect(() => {
    if (!enabled || !root) return;
    let cleanup: (() => void) | null = null;

    const onDown = (down: PointerEvent) => {
      if (down.pointerType !== 'mouse' || down.button !== 0 || down.ctrlKey || down.metaKey) return;
      const target = down.target instanceof Element ? down.target : null;
      if (!target || target.closest(NOT_FROM)) return;
      if (optionsRef.current.canStart && !optionsRef.current.canStart(target)) return;
      cleanup?.();

      const mode = lassoMode(down);
      const start = { x: down.clientX + globalThis.scrollX, y: down.clientY + globalThis.scrollY };
      let pointer = { x: down.clientX, y: down.clientY };
      let band: HTMLDivElement | null = null;
      let frame = 0;
      let last = 0;

      const draw = (now: number) => {
        frame = 0;
        const { topInset = 0 } = optionsRef.current;
        const speed = edgeSpeed(pointer.y, topInset, globalThis.innerHeight);
        if (speed !== 0 && last > 0) globalThis.scrollBy({ top: speed * Math.min(0.05, (now - last) / 1000), behavior: 'instant' });
        last = now;
        const rect = bandRect(start, { x: pointer.x + globalThis.scrollX, y: pointer.y + globalThis.scrollY });
        if (band) {
          band.style.transform = `translate(${rect.left - globalThis.scrollX}px, ${rect.top - globalThis.scrollY}px)`;
          band.style.width = `${rect.right - rect.left}px`;
          band.style.height = `${rect.bottom - rect.top}px`;
        }
        optionsRef.current.onBand(rect, mode);
        // Held at the edge, the page keeps scrolling though the pointer is still.
        if (speed !== 0) frame = requestAnimationFrame(draw);
      };

      const begin = () => {
        band = document.createElement('div');
        band.className = 'mrx-lasso';
        band.setAttribute('aria-hidden', 'true');
        document.body.append(band);
        document.body.classList.add('mrx-lassoing');
        globalThis.getSelection?.()?.removeAllRanges();
        setActive(true);
        optionsRef.current.onStart(mode);
      };

      const onMove = (move: PointerEvent) => {
        pointer = { x: move.clientX, y: move.clientY };
        if (!band) {
          if (!pastThreshold({ x: down.clientX, y: down.clientY }, pointer)) return;
          begin();
        }
        move.preventDefault();
        if (frame === 0) frame = requestAnimationFrame(draw);
      };

      const finish = (cancelled: boolean) => {
        const drawn = band !== null;
        cleanup?.();
        if (!drawn) return;
        if (cancelled) optionsRef.current.onCancel?.();
        else {
          optionsRef.current.onBand(bandRect(start, { x: pointer.x + globalThis.scrollX, y: pointer.y + globalThis.scrollY }), mode);
          optionsRef.current.onEnd?.();
          // The click the browser makes of this press and release is the lasso's, not a tile's.
          const swallow = (click: MouseEvent) => {
            click.stopPropagation();
            click.preventDefault();
          };
          globalThis.addEventListener('click', swallow, { capture: true, once: true });
          globalThis.setTimeout(() => globalThis.removeEventListener('click', swallow, { capture: true }), 0);
        }
      };
      const onUp = () => finish(false);
      // A wheel turned mid-lasso moves the page under a still pointer: the band follows it.
      const onScroll = () => {
        if (band && frame === 0) frame = requestAnimationFrame(draw);
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== 'Escape' || !band) return;
        key.preventDefault();
        key.stopPropagation();
        finish(true);
      };

      globalThis.addEventListener('pointermove', onMove);
      globalThis.addEventListener('pointerup', onUp);
      globalThis.addEventListener('pointercancel', onUp);
      globalThis.addEventListener('keydown', onKey, { capture: true });
      globalThis.addEventListener('scroll', onScroll, { passive: true });
      cleanup = () => {
        cleanup = null;
        if (frame !== 0) cancelAnimationFrame(frame);
        globalThis.removeEventListener('pointermove', onMove);
        globalThis.removeEventListener('pointerup', onUp);
        globalThis.removeEventListener('pointercancel', onUp);
        globalThis.removeEventListener('keydown', onKey, { capture: true });
        globalThis.removeEventListener('scroll', onScroll);
        if (band) {
          band.remove();
          band = null;
          document.body.classList.remove('mrx-lassoing');
          setActive(false);
        }
      };
    };

    root.addEventListener('pointerdown', onDown);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      cleanup?.();
    };
  }, [enabled, root]);

  return { active };
}
