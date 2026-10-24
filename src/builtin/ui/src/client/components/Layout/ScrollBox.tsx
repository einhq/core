import { type CSSProperties, type HTMLAttributes, type ReactNode, type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { bindScrollbar } from './scrollbar.ts';

/**
 * A box that scrolls on its own with the app's scrollbar (`bindScrollbar`) over its right edge, in
 * place of the browser's, which takes width when it comes and so reflows what the box holds. The
 * frame takes `frameStyle` and sizes the box; the rest of the props go on the element that
 * scrolls, which fills the frame, and `viewportRef` is that element. `ground` lies in the frame
 * behind what scrolls and stays where it is as that scrolls over it.
 */
export function ScrollBox(
  { frameStyle, viewportRef: outerRef, ground, children, ...viewport }: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & {
    frameStyle?: CSSProperties;
    viewportRef?: Ref<HTMLDivElement>;
    ground?: ReactNode;
  },
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(outerRef, () => viewportRef.current!, []);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!element || !track || !thumb) return;
    return bindScrollbar(track, thumb, {
      element,
      events: element,
      // The scroll's length is what the box holds, its children, which change as it renders.
      watch: (changed) => {
        const resized = new ResizeObserver(changed);
        const observe = () => {
          resized.disconnect();
          resized.observe(element);
          for (const child of element.children) resized.observe(child);
          changed();
        };
        const added = new MutationObserver(observe);
        added.observe(element, { childList: true });
        observe();
        return () => {
          resized.disconnect();
          added.disconnect();
        };
      },
    });
  }, []);

  return (
    <div className='mrx-scroll-box' style={frameStyle}>
      {ground}
      <div ref={viewportRef} {...viewport} className='mrx-scroll-box-viewport'>
        {children}
      </div>
      <div ref={trackRef} className='mrx-scrollbar mrx-scroll-box-scrollbar' aria-hidden>
        <div ref={thumbRef} className='mrx-scrollbar-thumb' />
      </div>
    </div>
  );
}
