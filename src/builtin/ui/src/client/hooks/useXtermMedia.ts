import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

type MediaInfo = {
  uid: string;
  lines: number;
  src: string;
  el: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
};

export function useXtermMedia(
  term: Terminal,
  xtermRef: React.RefObject<HTMLElement | null>,
  options: {
    mediaBaseUrl: string;
  },
) {
  const mediasRef = useRef<Map<string, MediaInfo>>(new Map());
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = xtermRef.current;
    if (!container) return;

    const rows = container.querySelector('.xterm-rows') as HTMLElement;
    if (!rows) return;

    rows.style.position ||= 'relative';

    // overlay div
    let overlay = overlayRef.current;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'xterm-img-overlay';
      overlay.style.position = 'absolute';
      overlay.style.inset = '0';
      overlay.style.overflow = 'hidden'; // ensures clipping
      rows.appendChild(overlay);
      overlayRef.current = overlay;
    }

    const MEDIA_REGEX = /__([^:\s]+):([^:\s]+):([^:\s]+):(\d+):(\d+)/;

    // --- scan for new markers ---
    function scan() {
      // reset visibility and remove stale data-uid for all previously hidden rows
      rows.querySelectorAll('[data-xterm-media-hidden]').forEach((el) => {
        (el as HTMLElement).style.visibility = 'visible';
        el.removeAttribute('data-xterm-media-hidden');
        el.removeAttribute('data-uid');
      });

      const walker = document.createTreeWalker(
        rows,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (!(node instanceof HTMLElement)) return NodeFilter.FILTER_SKIP;
            if (!(node.textContent?.includes('__IMG:') || node.textContent?.includes('__VID:') || node.textContent?.includes('__AUD:'))) return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );

      const foundUids = new Set<string>();

      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        const text = el.textContent ?? '';
        const match = text.match(MEDIA_REGEX);
        if (!match) continue;

        const [, typeName, srcPath, uid, linesStr] = match;
        const src = `${options.mediaBaseUrl}${srcPath}`;
        const lines = Number(linesStr);
        foundUids.add(uid);

        // hide the marker line and add uid for lookup
        el.style.visibility = 'hidden';
        el.setAttribute('data-xterm-media-hidden', 'true');
        el.setAttribute('data-uid', uid);

        let elType: 'img' | 'video' | 'audio' = 'img';
        if (typeName === 'VID') {
          elType = 'video';
        } else if (typeName === 'AUD') {
          elType = 'audio';
        }

        if (!mediasRef.current.has(uid)) {
          const el = document.createElement(elType);
          el.src = src;
          el.style.position = 'absolute';
          el.style.objectFit = 'contain';
          el.style.zIndex = '10';
          overlay!.appendChild(el);

          if (elType === 'video') {
            (el as HTMLVideoElement).controls = true;
            (el as HTMLVideoElement).autoplay = true;
            (el as HTMLVideoElement).playsInline = true;
            (el as HTMLVideoElement).style.maxWidth = '100%';
          } else if (elType === 'audio') {
            (el as HTMLAudioElement).controls = true;
            (el as HTMLAudioElement).autoplay = true;
            (el as HTMLVideoElement).style.minWidth = '400px';
            (el as HTMLVideoElement).style.maxWidth = '100%';
          }

          mediasRef.current.set(uid, {
            uid,
            lines,
            src,
            el: el,
          });
        }
      }

      // remove deleted images
      for (const uid of mediasRef.current.keys()) {
        if (!foundUids.has(uid)) {
          const info = mediasRef.current.get(uid)!;
          info.el.remove();
          mediasRef.current.delete(uid);
        }
      }

      positionAll();
    }

    // --- position images ---
    function positionAll() {
      const rowsRect = rows.getBoundingClientRect();

      for (const info of mediasRef.current.values()) {
        const { uid, el: imgEl, lines } = info;

        // Find ANY visible marker for this image that still has valid content
        // (data-uid can persist on recycled elements with different content)
        const allMarkers = rows.querySelectorAll(`[data-uid="${uid}"]`);

        let markerEl: HTMLElement | null = null;
        let match: RegExpMatchArray | null = null;

        for (const el of allMarkers) {
          const text = el.textContent ?? '';
          const m = text.match(MEDIA_REGEX);
          if (m && m[3] === uid) {
            markerEl = el as HTMLElement;
            match = m;
            break;
          }
        }

        if (!markerEl || !match) {
          imgEl.style.display = 'none';
          continue;
        }

        const index = Number(match[5]);
        const markerRect = markerEl.getBoundingClientRect();
        const rowHeight = markerRect.height;
        const imgHeight = lines * rowHeight;

        // Calculate marker position relative to rows container
        const markerTop = markerRect.top - rowsRect.top;

        // Calculate where row 0 should be based on this marker's position and index
        const row0Top = markerTop - (index * rowHeight);

        // Hide only if completely out of view
        const containerHeight = rowsRect.height;
        if (row0Top + imgHeight <= 0 || row0Top >= containerHeight) {
          imgEl.style.display = 'none';
          continue;
        }

        // Position at row0Top (can be negative), let overlay's overflow:hidden clip
        imgEl.style.top = `${row0Top}px`;
        imgEl.style.height = `${imgHeight}px`;
        imgEl.style.width = 'auto';
        imgEl.style.display = 'block';
      }
    }

    // --- setup observers and terminal hooks ---
    const observer = new MutationObserver(scan);
    observer.observe(rows, { childList: true, subtree: true, characterData: true });

    rows.addEventListener('scroll', positionAll);
    globalThis.addEventListener('resize', positionAll);

    term.onRender(positionAll);
    term.onScroll(positionAll);
    term.onResize(positionAll);

    scan();

    return () => {
      observer.disconnect();
      rows.removeEventListener('scroll', positionAll);
      globalThis.removeEventListener('resize', positionAll);
      overlay?.remove();
      mediasRef.current.forEach((info) => {
        info.el.remove();
      });
      mediasRef.current.clear();
    };
  }, [term, xtermRef, options.mediaBaseUrl]);
}
