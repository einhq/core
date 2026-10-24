/**
 * Pictures dragged within the page: what is carried, held in a signal for the drag's length,
 * while the drag itself carries only a token for it (`MEDIA_DRAG_MIME`) and a count as text. A
 * drop target reads what it would receive while the pointer is over it, which the browser's own
 * drag data never shows before the drop, and a drop whose token is not the one held (a drag from
 * another tab, or one already over) receives nothing.
 */
import { signal } from '@preact/signals-react';
import { setDragChip } from './drag-chip.ts';

/** The drag data type that marks a drag of pictures from this page; its value is the token. */
export const MEDIA_DRAG_MIME = 'application/x-ein-media';

/**
 * What a drag of pictures carries: containers whole (`groups`, by path), files one by one, the
 * members of those containers left out (`except`), how many pictures that is in all, and what the
 * chip says of it.
 */
export type MediaDragPayload = { label: string; count: number; groups: readonly string[]; files: readonly string[]; except: readonly string[] };

/** The drag under way, with its token; null when none is. */
export const mediaDrag = signal<{ token: string; payload: MediaDragPayload } | null>(null);

let drags = 0;

/** Hold `payload` as the drag under way; returns the token the drag data carries for it. */
export function holdMediaDrag(payload: MediaDragPayload): string {
  const token = `media-drag-${++drags}-${Date.now().toString(36)}`;
  mediaDrag.value = { token, payload };
  return token;
}

/** What the drag whose token is `token` carries: null for another token, or none. */
export function takeMediaDrag(token: string | null | undefined): MediaDragPayload | null {
  const held = mediaDrag.peek();
  return token && held?.token === token ? held.payload : null;
}

/** The drag is over, dropped or not. */
export function endMediaDrag(): void {
  mediaDrag.value = null;
}

/** Whether a drag's types say it is a drag of pictures from this page. */
export const isMediaDrag = (types: readonly string[] | DOMStringList): boolean => [...types].includes(MEDIA_DRAG_MIME);

/**
 * Start dragging `payload` from `source`: it is held, the drag data carries its token and its
 * count, and the browser draws a chip of the label rather than the source.
 */
export function startMediaDrag(event: { dataTransfer: DataTransfer | null }, payload: MediaDragPayload, source: HTMLElement | null): void {
  if (!event.dataTransfer) return;
  const token = holdMediaDrag(payload);
  event.dataTransfer.setData(MEDIA_DRAG_MIME, token);
  event.dataTransfer.setData('text/plain', String(payload.count));
  event.dataTransfer.effectAllowed = 'move';
  setDragChip(event, source, payload.label);
}
