import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { rollStops } from '../../lib/roll.ts';

/** How long a line rests before the next glides in, and how long the glide takes. */
const HOLD_MS = 4500;
const GLIDE_MS = 1400;
const EASE = 'cubic-bezier(0.45, 0, 0.2, 1)';

/** With reduced motion, the list fades out and in at the next line instead of gliding. */
const FADE_MS = 450;

/** How long a list stands still after the pointer last moved over it. */
const POINTER_REST_MS = 6000;

/** How far the list fades out at its start and end while it rolls. */
const FADE_START = '0.6em';
const FADE_END = '2.4em';

const reducedMotion = (): boolean => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

type Props = {
  /** The rows, each a keyed element; they are drawn twice while the list rolls. */
  children: ReactNode;
  /** `y` rolls upwards, `x` leftwards. */
  axis?: 'y' | 'x';
  /** The space between rows, and twice it between the end and the start again. */
  gap?: string;
  /** How the rows are laid out, in place of a column (or a row, for `x`) with `gap` between them: a grid's lines roll as one. */
  lines?: CSSProperties;
  /** The box's own style: its font size and the like. */
  style?: CSSProperties;
  hold?: number;
  glide?: number;
};

/**
 * A list for a screen nobody scrolls: rows that fit stand still, as does a single line too long for
 * the box; rows that do not fit roll, a line at a time — a pause, then the next line glides up
 * (left, for `x`) while the one leaving fades out at the box's start and those coming fade in at
 * its end — and after the last line the first comes round again, below a hairline. It moves by a composited transform, and runs on from a copy of the
 * list drawn after it, so the loop never jumps. It stands still while the pointer moves over it,
 * and fades from line to line rather than moving for someone who asks for reduced motion.
 */
export function RollingList({ children, axis = 'y', gap = '0.6em', lines, style, hold = HOLD_MS, glide = GLIDE_MS }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLDivElement>(null);
  const [rolling, setRolling] = useState(false);
  const [stops, setStops] = useState<number[]>([0]);
  const [at, setAt] = useState(0);
  const [moving, setMoving] = useState(false);
  const [faded, setFaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const resume = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fade = useRef<ReturnType<typeof setTimeout>>(undefined);
  const across = axis === 'x';

  // What the list holds and where its lines start, read again whenever it or its box changes size.
  const measure = useCallback(() => {
    const frame = box.current;
    const list = first.current;
    if (!frame || !list) return;
    const room = across ? frame.clientWidth : frame.clientHeight;
    const length = across ? list.scrollWidth : list.scrollHeight;
    const origin = list.getBoundingClientRect();
    const startOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return across ? rect.left - origin.left : rect.top - origin.top;
    };
    const starts = [...list.children].map(startOf);
    // One line too long for the box would only roll round to itself: it stands still, cut off.
    const overflows = length > room + 1 && rollStops(starts, Infinity).length > 2;
    setRolling(overflows);
    if (!overflows || !second.current) return;
    const next = rollStops(starts, startOf(second.current));
    setStops((was) => (was.length === next.length && was.every((stop, i) => Math.abs(stop - next[i]) < 0.5) ? was : next));
  }, [across]);

  useEffect(() => {
    const frame = box.current;
    const list = first.current;
    if (!frame || !list) return;
    const resized = new ResizeObserver(measure);
    const watch = () => {
      resized.disconnect();
      resized.observe(frame);
      resized.observe(list);
      for (const row of list.children) resized.observe(row);
      measure();
    };
    const changed = new MutationObserver(watch);
    changed.observe(list, { childList: true });
    watch();
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [measure]);

  // The copy is drawn once the list rolls; where it starts is only known then.
  useLayoutEffect(measure, [rolling, measure]);

  useEffect(() => {
    if (!rolling) {
      setMoving(false);
      setAt(0);
    }
  }, [rolling]);

  const last = stops.length - 1;
  const index = Math.min(at, last);

  useEffect(() => {
    if (!rolling || paused || last < 1) return;
    // On the copy: once the glide there is over, back to the same place in the list itself.
    if (index === last) {
      const timer = setTimeout(() => {
        setMoving(false);
        setAt(0);
      }, glide);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      if (!reducedMotion()) {
        setMoving(true);
        setAt(index + 1);
        return;
      }
      setFaded(true);
      fade.current = setTimeout(() => {
        setMoving(false);
        setAt(index + 1 === last ? 0 : index + 1);
        setFaded(false);
      }, FADE_MS);
      // A line that has just glided in rests from when it is in place.
    }, moving ? glide + hold : hold);
    return () => {
      clearTimeout(timer);
      clearTimeout(fade.current);
    };
  }, [rolling, paused, index, last, hold, glide, moving]);

  useEffect(() => () => clearTimeout(resume.current), []);

  // Someone pointing at it wants it to stay; a pointer left resting on it does not hold it for good.
  const pointing = () => {
    setPaused(true);
    clearTimeout(resume.current);
    resume.current = setTimeout(() => setPaused(false), POINTER_REST_MS);
  };
  const left = () => {
    clearTimeout(resume.current);
    setPaused(false);
  };

  const direction = across ? 'to right' : 'to bottom';
  const mask = `linear-gradient(${direction}, transparent 0, #000 ${FADE_START}, #000 calc(100% - ${FADE_END}), transparent 100%)`;
  const offset = rolling ? stops[index] ?? 0 : 0;
  const copy: CSSProperties = lines ?? {
    display: 'flex',
    flexDirection: across ? 'row' : 'column',
    gap,
    ...(across ? { width: 'max-content', alignItems: 'center' } : {}),
  };

  return (
    <div
      ref={box}
      onPointerMove={pointing}
      onPointerDown={pointing}
      onPointerLeave={left}
      style={{
        overflow: 'hidden',
        ...(across ? { width: '100%', height: '100%' } : { height: '100%' }),
        ...(rolling ? { maskImage: mask, WebkitMaskImage: mask } : {}),
        ...style,
      }}
    >
      <div
        style={{
          ...(across
            ? { display: 'flex', alignItems: 'center', height: '100%', width: 'max-content', paddingLeft: rolling ? FADE_START : 0 }
            : { paddingTop: rolling ? FADE_START : 0 }),
          transform: `translate3d(${across ? `${-offset}px, 0` : `0, ${-offset}px`}, 0)`,
          transition: [moving ? `transform ${glide}ms ${EASE}` : '', `opacity ${FADE_MS}ms ease`].filter(Boolean).join(', '),
          opacity: faded ? 0 : 1,
          willChange: rolling ? 'transform' : undefined,
        }}
      >
        <div ref={first} style={copy}>{children}</div>
        {rolling && (
          <div ref={second} aria-hidden style={{ ...copy, position: 'relative', ...(across ? { marginLeft: `calc(${gap} * 2)` } : { marginTop: `calc(${gap} * 2)` }) }}>
            <span
              style={{
                position: 'absolute',
                ...(across
                  ? { left: `calc(${gap} * -1)`, top: '15%', bottom: '15%', width: 1, background: 'linear-gradient(transparent, var(--mrx-hairline), transparent)' }
                  : { top: `calc(${gap} * -1)`, left: '12%', right: '12%', height: 1, background: 'linear-gradient(90deg, transparent, var(--mrx-hairline), transparent)' }),
              }}
            />
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
