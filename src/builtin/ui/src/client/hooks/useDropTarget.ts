import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { isMediaDrag, MEDIA_DRAG_MIME, mediaDrag, type MediaDragPayload, takeMediaDrag } from '../lib/media-drag.ts';

export type DropTargetOptions = {
  /**
   * What a drop of `payload` here would do, as the target says it while the pointer is over it
   * ("Move 12 photos here"); null refuses it.
   */
  accept: (payload: MediaDragPayload) => string | null;
  onDrop: (payload: MediaDragPayload) => void;
  /** Off, the target takes nothing. */
  disabled?: boolean;
};

export type DropTarget = {
  /** Spread on the element that takes the drop. */
  props: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  /** What a drop would do, while a drag of pictures it takes is over it; null otherwise. */
  over: string | null;
};

/**
 * A place pictures dragged on the page (`startMediaDrag`) can be dropped: it names what it would
 * do as the pointer arrives, and takes only what `accept` names. Drags of anything else (files
 * from the desktop, rows of the Nodes page) pass it by, so Mantine's full-screen dropzone and the
 * other targets keep theirs.
 */
export function useDropTarget(options: DropTargetOptions): DropTarget {
  const [over, setOver] = useState<string | null>(null);
  const depth = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // A drag that ends without leaving (Escape, a drop elsewhere) leaves nothing marked.
  useEffect(() =>
    mediaDrag.subscribe((held) => {
      if (held) return;
      depth.current = 0;
      setOver(null);
    }), []);

  const props = useMemo(() => {
    const label = (event: DragEvent): string | null => {
      if (optionsRef.current.disabled || !isMediaDrag(event.dataTransfer.types)) return null;
      const held = mediaDrag.peek();
      return held ? optionsRef.current.accept(held.payload) : null;
    };
    return {
      onDragEnter: (event: DragEvent) => {
        const action = label(event);
        if (action === null) return;
        event.preventDefault();
        depth.current++;
        setOver(action);
      },
      onDragOver: (event: DragEvent) => {
        const action = label(event);
        if (action === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver((previous) => previous === action ? previous : action);
      },
      onDragLeave: (event: DragEvent) => {
        if (!isMediaDrag(event.dataTransfer.types)) return;
        // Entering a child leaves the parent first; only the last leave is the pointer going.
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(null);
      },
      onDrop: (event: DragEvent) => {
        depth.current = 0;
        setOver(null);
        if (optionsRef.current.disabled || !isMediaDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        const payload = takeMediaDrag(event.dataTransfer.getData(MEDIA_DRAG_MIME));
        if (payload && optionsRef.current.accept(payload) !== null) optionsRef.current.onDrop(payload);
      },
    };
  }, []);

  return { props, over };
}
